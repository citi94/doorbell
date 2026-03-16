'use strict';

process.on('uncaughtException', (err) => {
  const ts = new Date().toISOString();
  console.error(`[${ts}] UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const ts = new Date().toISOString();
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
  console.error(`[${ts}] UNHANDLED REJECTION: ${msg}`);
  process.exit(1);
});

require('dotenv').config({ path: '/opt/doorbell/.env' });

const { EufySecurity, P2PConnectionType } = require('eufy-security-client');
const hap = require('@homebridge/hap-nodejs');
const { spawn } = require('child_process');
const { pickPort } = require('pick-port');

const {
  Accessory,
  Characteristic,
  Service,
  uuid,
  CameraController,
} = hap;

// HAP-nodejs const enum values (inlined at TS compile time, need raw values in JS)
const Categories = { VIDEO_DOORBELL: 18 };
const SRTPCryptoSuites = { AES_CM_128_HMAC_SHA1_80: 0 };
const H264Profile = { BASELINE: 0, MAIN: 1, HIGH: 2 };
const H264Level = { LEVEL3_1: 0, LEVEL3_2: 1, LEVEL4_0: 2 };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const EUFY_USERNAME = process.env.EUFY_USERNAME;
const EUFY_PASSWORD = process.env.EUFY_PASSWORD;
const EUFY_COUNTRY = process.env.EUFY_COUNTRY || 'US';
const DEVICE_SERIAL = process.env.DEVICE_SERIAL;       // E340 serial
const HOMEKIT_PIN = process.env.HOMEKIT_PIN || '123-45-678';
const HOMEKIT_USERNAME = process.env.HOMEKIT_USERNAME || 'AA:BB:CC:DD:EE:FF';
const HOMEKIT_PORT = parseInt(process.env.HOMEKIT_PORT || '47128', 10);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || ''; // HTTP Basic Auth

if (!EUFY_USERNAME || !EUFY_PASSWORD || !DEVICE_SERIAL) {
  console.error('Missing required env vars: EUFY_USERNAME, EUFY_PASSWORD, DEVICE_SERIAL');
  process.exit(1);
}

const ALLOWED_PERIODS = ['-1 day', '-7 days', '-30 days', '-90 days', '-365 days'];
function sanitizePeriod(p) { return ALLOWED_PERIODS.includes(p) ? p : '-1 day'; }

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Event database (SQLite)
// ---------------------------------------------------------------------------

const { DatabaseSync } = require('node:sqlite');
const DB_PATH = '/opt/doorbell/events.db';
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    type TEXT NOT NULL,
    detail TEXT,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
`);

const insertEvent = db.prepare(
  'INSERT INTO events (type, detail, meta) VALUES (?, ?, ?)'
);

const queryEvents = db.prepare(
  'SELECT id, timestamp, type, detail FROM events WHERE type != ? ORDER BY id DESC LIMIT ?'
);
const queryEventsByType = db.prepare(
  'SELECT id, timestamp, type, detail FROM events WHERE type = ? ORDER BY id DESC LIMIT ?'
);
const queryStats = db.prepare(`
  SELECT type, COUNT(*) as count FROM events
  WHERE type NOT IN ('heartbeat', 'stream_start', 'stream_stop')
  AND timestamp >= datetime('now', ?)
  GROUP BY type ORDER BY count DESC
`);
const queryHourly = db.prepare(`
  SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, COUNT(*) as count
  FROM events WHERE type IN ('motion', 'person', 'ring')
  AND timestamp >= datetime('now', ?) GROUP BY hour ORDER BY hour
`);
const queryFaces = db.prepare(`
  SELECT detail as name, COUNT(*) as count, MAX(timestamp) as last_seen
  FROM events WHERE type = 'face'
  AND timestamp >= datetime('now', ?) GROUP BY detail ORDER BY count DESC
`);
const queryDaily = db.prepare(`
  SELECT date(timestamp) as day, type, COUNT(*) as count
  FROM events WHERE type NOT IN ('heartbeat', 'stream_start', 'stream_stop')
  AND timestamp >= datetime('now', ?)
  GROUP BY day, type ORDER BY day DESC
`);
const querySearch = db.prepare(`
  SELECT id, timestamp, type, detail FROM events
  WHERE detail LIKE ? AND type != 'heartbeat'
  ORDER BY id DESC LIMIT ?
`);
const queryExport = db.prepare(`
  SELECT id, timestamp, type, detail, meta FROM events
  WHERE type != 'heartbeat'
  AND timestamp >= ? AND timestamp <= ?
  ORDER BY id LIMIT 50001
`);
const queryExportByType = db.prepare(`
  SELECT id, timestamp, type, detail, meta FROM events
  WHERE type = ?
  AND timestamp >= ? AND timestamp <= ?
  ORDER BY id LIMIT 50001
`);
const queryLastHeartbeat = db.prepare(`
  SELECT timestamp, meta FROM events WHERE type = 'heartbeat'
  ORDER BY id DESC LIMIT 1
`);
const queryTotalCount = db.prepare(`
  SELECT COUNT(*) as count FROM events WHERE type != 'heartbeat'
`);

function event(type, detail, meta) {
  try {
    insertEvent.run(type, detail || null, meta ? JSON.stringify(meta) : null);
  } catch (err) {
    log(`DB error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Dashboard (HTTP)
// ---------------------------------------------------------------------------

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

const DASHBOARD_HTML = fs.readFileSync(
  path.join(__dirname, 'dashboard.html'), 'utf8'
);

const httpServer = http.createServer((req, res) => {
  // Basic auth (if DASHBOARD_PASSWORD is set)
  if (DASHBOARD_PASSWORD) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Doorbell"' });
      res.end('Unauthorized');
      return;
    }
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const pass = decoded.substring(decoded.indexOf(':') + 1);
    if (pass !== DASHBOARD_PASSWORD) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Doorbell"' });
      res.end('Unauthorized');
      return;
    }
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(DASHBOARD_HTML);
      return;
    }
    if (url.pathname === '/api/events') {
      const type = url.searchParams.get('type') || '';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
      const rows = type
        ? queryEventsByType.all(type, limit)
        : queryEvents.all('heartbeat', limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
      return;
    }
    if (url.pathname === '/api/stats') {
      const period = sanitizePeriod(url.searchParams.get('period') || '-1 day');
      const rows = queryStats.all(period);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
      return;
    }
    if (url.pathname === '/api/hours') {
      const period = sanitizePeriod(url.searchParams.get('period') || '-1 day');
      const rows = queryHourly.all(period);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
      return;
    }
    if (url.pathname === '/api/faces') {
      const period = sanitizePeriod(url.searchParams.get('period') || '-1 day');
      const rows = queryFaces.all(period);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
      return;
    }
    if (url.pathname === '/api/status') {
      const uptimeSec = Math.floor(process.uptime());
      const hb = queryLastHeartbeat.all();
      const total = queryTotalCount.get();
      let dbSize = 0;
      try { dbSize = fs.statSync(DB_PATH).size; } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        uptime: uptimeSec,
        device: eufyDevice ? eufyDevice.getName() : null,
        sessions: Object.keys(activeSessions).length,
        dbSize,
        totalEvents: total.count,
        lastHeartbeat: hb.length ? hb[0].timestamp : null,
        startedAt: new Date(Date.now() - uptimeSec * 1000).toISOString(),
      }));
      return;
    }
    if (url.pathname === '/api/daily') {
      const period = sanitizePeriod(url.searchParams.get('period') || '-7 days');
      const rows = queryDaily.all(period);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
      return;
    }
    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q') || '';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
      const rows = q ? querySearch.all(`%${q}%`, limit) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
      return;
    }
    if (url.pathname === '/api/export') {
      const format = url.searchParams.get('format') || 'csv';
      const type = url.searchParams.get('type') || '';
      const from = url.searchParams.get('from') || '2000-01-01T00:00:00Z';
      const to = url.searchParams.get('to') || '2099-12-31T23:59:59Z';
      const rows = type
        ? queryExportByType.all(type, from, to)
        : queryExport.all(from, to);
      if (rows.length > 50000) {
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('Too many rows. Narrow the date range.');
        return;
      }
      if (format === 'json') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="doorbell-events.json"',
        });
        res.end(JSON.stringify(rows, null, 2));
      } else {
        const header = 'id,timestamp,type,detail,meta';
        const csvRows = rows.map(r =>
          [r.id, r.timestamp, r.type, csvEscape(r.detail), csvEscape(r.meta)].join(',')
        );
        res.writeHead(200, {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="doorbell-events.csv"',
        });
        res.end(header + '\n' + csvRows.join('\n'));
      }
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    log(`HTTP error: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error');
  }
});

httpServer.listen(80, () => log('Dashboard listening on port 80'));

// ---------------------------------------------------------------------------
// Eufy state
// ---------------------------------------------------------------------------

let eufyClient = null;
let eufyDevice = null;

// Active P2P streams keyed by HomeKit session ID
const activeSessions = {};

// Reconnection state
let reconnectDelay = 10;
let reconnectTimer = null;
let reconnecting = false;

// Push health tracking
let lastDetectionTime = Date.now();

// Snapshot cache
let cachedSnapshot = null;      // Buffer (JPEG)
let cachedSnapshotTime = 0;     // Date.now() when cached
let cachedSnapshotUrl = null;   // URL it was fetched from
let snapshotRefreshTimer = null;
let heartbeatInterval = null;
let cloudRefreshInterval = null;
let snapshotGrabInterval = null;
let pushWatchdogInterval = null;
let snapshotGrabActive = false; // true when doing a quick P2P grab
let streamPending = false;      // true while HomeKit stream is being set up
let lastPersonTime = 0;         // Date.now() of last person/ring detection
const PERSON_HOLD = 600000;     // 10 minutes

// After a detection event, refresh cloud data to get the updated snapshot
function scheduleSnapshotRefresh() {
  if (snapshotRefreshTimer) return;
  snapshotRefreshTimer = setTimeout(async () => {
    snapshotRefreshTimer = null;
    if (!eufyClient) return;
    try {
      await eufyClient.refreshCloudData();
      log('Post-detection cloud refresh done');
    } catch (err) {
      log(`Post-detection cloud refresh failed: ${err.message}`);
    }
  }, 3000); // 3s delay for cloud to process the event image
}

async function fetchSnapshot(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error('too small');
    return buf;
  } catch (err) {
    log(`Snapshot fetch failed: ${err.message}`);
    return null;
  }
}

function resizeSnapshot(jpegBuf, width, height) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'mjpeg', '-i', 'pipe:0',
      '-vf', `scale=${width}:${height}`,
      '-f', 'mjpeg', '-q:v', '5', '-',
    ];
    const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let resolved = false;
    const done = (buf) => { if (!resolved) { resolved = true; resolve(buf); } };
    const timer = setTimeout(() => { ff.kill('SIGKILL'); done(jpegBuf); }, 5000);
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 && chunks.length ? Buffer.concat(chunks) : jpegBuf);
    });
    ff.on('error', () => done(jpegBuf));
    ff.stdin.on('error', () => {});
    ff.stdin.end(jpegBuf);
  });
}

// ---------------------------------------------------------------------------
// HomeKit Accessory
// ---------------------------------------------------------------------------

const doorbellUUID = uuid.generate('doorbell:eufy:' + DEVICE_SERIAL);
const accessory = new Accessory('Doorbell', doorbellUUID);

// Set manufacturer info
const infoService = accessory.getService(Service.AccessoryInformation);
infoService.setCharacteristic(Characteristic.Manufacturer, 'Eufy');
infoService.setCharacteristic(Characteristic.Model, 'E340');
infoService.setCharacteristic(Characteristic.SerialNumber, DEVICE_SERIAL);

// ---------------------------------------------------------------------------
// Streaming delegate
// ---------------------------------------------------------------------------

const streamingDelegate = {
  async handleSnapshotRequest(request, callback) {
    const { width, height } = request;

    // Serve cached snapshot (always the best we have)
    if (cachedSnapshot) {
      const resized = await resizeSnapshot(cachedSnapshot, width, height);
      callback(undefined, resized);
      return;
    }

    // Try fetching from last known URL
    if (cachedSnapshotUrl) {
      const buf = await fetchSnapshot(cachedSnapshotUrl);
      if (buf) {
        cachedSnapshot = buf;
        cachedSnapshotTime = Date.now();
        log('Snapshot fetched from cloud URL');
        const resized = await resizeSnapshot(buf, width, height);
        callback(undefined, resized);
        return;
      }
    }

    // Last resort: black placeholder
    log('No snapshot available — black placeholder');
    const args = [
      '-f', 'lavfi',
      '-i', `color=c=black:s=${width}x${height}:d=1`,
      '-vframes', '1', '-f', 'mjpeg', '-',
    ];
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    let done = false;
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('close', (code) => {
      if (done) return;
      done = true;
      callback(code === 0 && chunks.length ? undefined : new Error('snapshot failed'),
        chunks.length ? Buffer.concat(chunks) : undefined);
    });
    ff.on('error', (err) => { if (!done) { done = true; callback(err); } });
  },

  async prepareStream(request, callback) {
    const sessionId = request.sessionID;
    const t0 = Date.now();

    try {
      const videoReturnPort = await pickPort({ type: 'udp', reserveTimeout: 15 });
      const audioReturnPort = await pickPort({ type: 'udp', reserveTimeout: 15 });
      log(`[${sessionId.substring(0, 8)}] prepareStream ports allocated in ${Date.now() - t0}ms`);
      const videoSSRC = CameraController.generateSynchronisationSource();
      const audioSSRC = CameraController.generateSynchronisationSource();

      activeSessions[sessionId] = {
        address: request.targetAddress,
        videoPort: request.video.port,
        videoReturnPort,
        videoCryptoSuite: request.video.srtpCryptoSuite,
        videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
        videoSSRC,
        audioPort: request.audio.port,
        audioReturnPort,
        audioCryptoSuite: request.audio.srtpCryptoSuite,
        audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
        audioSSRC,
        audioPt: null,          // stored at stream start for deferred return audio
        ffmpegProcess: null,
        videoStream: null,
        audioFfmpegProcess: null,
        audioStream: null,
        snapshotFfmpeg: null,    // stream-snapshot ffmpeg (killed on stop)
        returnAudioFfmpeg: null,
        talkbackActive: false,
        talkbackStream: null,
        streamStartTime: 0,     // Date.now() for latency tracking
      };

      callback(undefined, {
        video: {
          port: videoReturnPort,
          ssrc: videoSSRC,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
        audio: {
          port: audioReturnPort,
          ssrc: audioSSRC,
          srtp_key: request.audio.srtp_key,
          srtp_salt: request.audio.srtp_salt,
        },
      });
    } catch (err) {
      log(`prepareStream error: ${err.message}`);
      callback(err);
    }
  },

  handleStreamRequest(request, callback) {
    const sessionId = request.sessionID;

    if (request.type === 'start') {
      const session = activeSessions[sessionId];
      if (!session) {
        log(`No prepared session for ${sessionId}`);
        callback();
        return;
      }
      startLivestream(session, sessionId, request.video, request.audio);
      callback();
    } else if (request.type === 'stop') {
      stopStream(sessionId);
      callback();
    } else if (request.type === 'reconfigure') {
      log(`Reconfigure request for session ${sessionId} — acknowledged`);
      callback();
    }
  },
};

// ---------------------------------------------------------------------------
// DoorbellController
// ---------------------------------------------------------------------------

const doorbellController = new hap.DoorbellController({
  cameraStreamCount: 1,
  delegate: streamingDelegate,
  streamingOptions: {
    supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
    video: {
      codec: {
        profiles: [H264Profile.BASELINE, H264Profile.MAIN],
        levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2],
      },
      resolutions: [
        [1280, 720, 15],
        [640, 480, 15],
        [640, 360, 15],
        [320, 240, 15],
      ],
    },
    audio: {
      twoWayAudio: true,
      codecs: [{
        type: 'AAC-eld',
        samplerate: 16,
      }],
    },
  },
  sensors: {
    motion: true,
  },
});

accessory.configureController(doorbellController);

// Additional motion sensors for granular detection types
const personSensor = new Service.MotionSensor('Person', 'person');
personSensor.setCharacteristic(Characteristic.Name, 'Person');
personSensor.addOptionalCharacteristic(Characteristic.ConfiguredName);
personSensor.updateCharacteristic(Characteristic.ConfiguredName, 'Person');
const petSensor = new Service.MotionSensor('Pet', 'pet');
petSensor.setCharacteristic(Characteristic.Name, 'Pet');
petSensor.addOptionalCharacteristic(Characteristic.ConfiguredName);
petSensor.updateCharacteristic(Characteristic.ConfiguredName, 'Pet');
accessory.addService(personSensor);
accessory.addService(petSensor);

// Name the built-in motion sensor
const builtInMotion = doorbellController.motionService;
if (builtInMotion) {
  builtInMotion.setCharacteristic(Characteristic.Name, 'Motion');
  builtInMotion.addOptionalCharacteristic(Characteristic.ConfiguredName);
  builtInMotion.updateCharacteristic(Characteristic.ConfiguredName, 'Motion');
}

// ---------------------------------------------------------------------------
// Livestream management
// ---------------------------------------------------------------------------

async function startLivestream(session, sessionId, videoInfo, audioInfo) {
  const t0 = Date.now();
  const sid = sessionId.substring(0, 8);

  if (!eufyClient || !eufyDevice) {
    log('Eufy client or device not ready — cannot start stream');
    doorbellController.forceStopStreamingSession(sessionId);
    return;
  }

  try {
    session.streamStartTime = t0;
    session.audioPt = audioInfo.pt;
    streamPending = true;

    // 1. Fire P2P FIRST — this is the slowest step (2-5s), let it work while we set up ffmpeg
    const p2pPromise = eufyClient.startStationLivestream(DEVICE_SERIAL);
    log(`[${sid}] +${Date.now() - t0}ms P2P requested`);

    // 2. Spawn video ffmpeg while P2P establishes
    // nobuffer + zero probe: we know it's H.264, skip analysis for fastest first frame
    const ffmpegArgs = [
      '-hide_banner', '-loglevel', 'warning',
      '-fflags', '+genpts+nobuffer',
      '-analyzeduration', '0', '-probesize', '32',
      '-f', 'h264', '-i', 'pipe:0',
      '-codec:v', 'copy',
      '-payload_type', String(videoInfo.pt),
      '-f', 'rtp',
      '-flush_packets', '1',
      '-ssrc', String(session.videoSSRC),
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', session.videoSRTP.toString('base64'),
      `srtp://${session.address}:${session.videoPort}?rtcpport=${session.videoPort}&pkt_size=1316`,
    ];

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) log(`ffmpeg-video[${sid}]: ${msg}`);
    });

    ffmpegProcess.on('close', (code) => {
      log(`ffmpeg-video exited with code ${code} for session ${sid}`);
      if (activeSessions[sessionId]) {
        doorbellController.forceStopStreamingSession(sessionId);
      }
    });

    ffmpegProcess.on('error', (err) => {
      log(`ffmpeg-video spawn error: ${err.message}`);
    });

    ffmpegProcess.stdin.on('error', () => {}); // suppress EPIPE

    session.ffmpegProcess = ffmpegProcess;

    // 3. Spawn audio ffmpeg (also with reduced buffering)
    const audioFfmpegArgs = [
      '-hide_banner', '-loglevel', 'warning',
      '-fflags', '+genpts+nobuffer',
      '-analyzeduration', '0', '-probesize', '32',
      '-f', 'aac', '-i', 'pipe:0',
      '-codec:a', 'libfdk_aac', '-profile:a', 'aac_eld',
      '-ar', '16000', '-ac', '1', '-b:a', '24k',
      '-flags', '+global_header',
      '-payload_type', String(audioInfo.pt),
      '-f', 'rtp',
      '-flush_packets', '1',
      '-ssrc', String(session.audioSSRC),
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', session.audioSRTP.toString('base64'),
      `srtp://${session.address}:${session.audioPort}?rtcpport=${session.audioPort}&pkt_size=188`,
    ];

    const audioFfmpegProcess = spawn('/usr/local/bin/ffmpeg-hk', audioFfmpegArgs, {
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    audioFfmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) log(`ffmpeg-audio[${sid}]: ${msg}`);
    });

    audioFfmpegProcess.on('close', (code) => {
      log(`ffmpeg-audio exited with code ${code} for session ${sid}`);
    });

    audioFfmpegProcess.on('error', (err) => {
      log(`ffmpeg-audio spawn error: ${err.message}`);
    });

    audioFfmpegProcess.stdin.on('error', () => {}); // suppress EPIPE

    session.audioFfmpegProcess = audioFfmpegProcess;
    log(`[${sid}] +${Date.now() - t0}ms ffmpeg processes spawned`);

    // 4. Return audio ffmpeg deferred — only spawned when talkback actually starts
    //    Saves ~100ms process spawn from the critical video path

    // 5. Wait for P2P to establish
    await p2pPromise;
    streamPending = false;

    // Session may have been stopped while we were awaiting P2P
    if (!activeSessions[sessionId]) {
      log(`[${sid}] Session cancelled during P2P setup`);
      return;
    }

    log(`[${sid}] +${Date.now() - t0}ms P2P established`);
    event('stream_start', null);
  } catch (err) {
    streamPending = false;
    log(`Failed to start livestream: ${err.message}`);
    stopStream(sessionId);
  }
}

function stopStream(sessionId) {
  const session = activeSessions[sessionId];
  if (!session) return;

  log(`Stopping stream for session ${sessionId.substring(0, 8)}`);

  // Kill video ffmpeg
  if (session.ffmpegProcess) {
    try {
      session.ffmpegProcess.stdin.end();
      session.ffmpegProcess.kill('SIGTERM');
    } catch (e) { /* ignore */ }
    session.ffmpegProcess = null;
  }

  // Kill audio ffmpeg
  if (session.audioFfmpegProcess) {
    try {
      session.audioFfmpegProcess.stdin.end();
      session.audioFfmpegProcess.kill('SIGTERM');
    } catch (e) { /* ignore */ }
    session.audioFfmpegProcess = null;
  }

  // Kill snapshot ffmpeg
  if (session.snapshotFfmpeg) {
    try { session.snapshotFfmpeg.kill('SIGTERM'); } catch (e) {}
    session.snapshotFfmpeg = null;
  }

  // Detach video stream listener
  if (session.videoStream) {
    session.videoStream.removeAllListeners('data');
    session.videoStream = null;
  }

  // Detach audio stream listener
  if (session.audioStream) {
    session.audioStream.removeAllListeners('data');
    session.audioStream = null;
  }

  // Stop talkback
  if (session.talkbackActive && eufyClient) {
    eufyClient.stopStationTalkback(DEVICE_SERIAL)
      .catch((err) => log(`Stop talkback error: ${err.message}`));
    session.talkbackActive = false;
  }

  // Kill return audio ffmpeg
  if (session.returnAudioFfmpeg) {
    try {
      session.returnAudioFfmpeg.kill('SIGTERM');
    } catch (e) { /* ignore */ }
    session.returnAudioFfmpeg = null;
  }

  // Close talkback stream
  if (session.talkbackStream) {
    try { session.talkbackStream.destroy(); } catch (e) {}
    session.talkbackStream = null;
  }

  // Stop P2P
  if (eufyClient && eufyDevice) {
    eufyClient.stopStationLivestream(DEVICE_SERIAL)
      .catch((err) => log(`Stop livestream error: ${err.message}`));
  }

  event('stream_stop', null);
  delete activeSessions[sessionId];
}

// ---------------------------------------------------------------------------
// Eufy client initialization
// ---------------------------------------------------------------------------

async function initEufy() {
  log('Initializing eufy-security-client...');

  eufyClient = await EufySecurity.initialize({
    username: EUFY_USERNAME,
    password: EUFY_PASSWORD,
    country: EUFY_COUNTRY,
    persistentDir: '/opt/doorbell/persist',
    p2pConnectionSetup: P2PConnectionType.QUICKEST,
    pollingIntervalMinutes: 10,
    eventDurationSeconds: 10,
    acceptInvitations: false,
    enableEmbeddedPKCS1Support: true,
  });

  // Safety-net timeout: HomeKit doesn't reliably send stop, so cap P2P at 5 min.
  // HomeKit will re-request the stream if the user is still watching.
  eufyClient.setCameraMaxLivestreamDuration(300);

  // --- Connection events ---

  eufyClient.on('connect', () => {
    log('Eufy cloud connected');
    reconnectDelay = 10; // reset on success
  });

  eufyClient.on('close', (reason) => {
    log(`Eufy cloud disconnected: ${reason || 'unknown'}`);
    scheduleReconnect('cloud close');
  });

  eufyClient.on('connection error', (error) => {
    log(`Eufy connection error: ${error.message}`);
    scheduleReconnect('connection error');
  });

  eufyClient.on('push connect', () => log('Push notification connected'));
  eufyClient.on('push close', () => {
    log('Push notification disconnected');
    scheduleReconnect('push close');
  });

  // --- 2FA handling ---

  eufyClient.on('tfa request', () => {
    log('WARNING: 2FA requested — check Eufy app and restart with verifyCode');
  });

  eufyClient.on('captcha request', (id, captcha) => {
    log(`WARNING: CAPTCHA requested (id: ${id}) — manual intervention needed`);
  });

  // --- Device discovery ---

  eufyClient.on('device added', (device) => {
    log(`Device discovered: ${device.getName()} (${device.getSerial()})`);
    if (device.getSerial() === DEVICE_SERIAL) {
      eufyDevice = device;
      log(`Target device found: ${device.getName()}`);
    }
  });

  eufyClient.on('station added', (station) => {
    log(`Station discovered: ${station.getName()} (${station.getSerial()})`);
  });

  // --- Doorbell ring ---

  eufyClient.on('device rings', (device, state) => {
    if (state && device.getSerial() === DEVICE_SERIAL) {
      log('DOORBELL RING — triggering HomeKit chime');
      lastDetectionTime = Date.now();
      lastPersonTime = Date.now();
      event('ring', null);
      doorbellController.ringDoorbell();
      scheduleSnapshotRefresh();
    }
  });

  // --- Motion / person / pet detection ---

  eufyClient.on('device motion detected', (device, state) => {
    if (device.getSerial() === DEVICE_SERIAL) {
      log(`Motion detected: ${state}`);
      if (state) { lastDetectionTime = Date.now(); event('motion', null); scheduleSnapshotRefresh(); }
      updateMotion(state);
    }
  });

  eufyClient.on('device person detected', (device, state, person) => {
    if (device.getSerial() === DEVICE_SERIAL) {
      log(`Person detected: ${state}${person ? ` (${person})` : ''}`);
      if (state) { lastDetectionTime = Date.now(); lastPersonTime = Date.now(); event('person', person || null); scheduleSnapshotRefresh(); }
      updateMotion(state);
      personSensor.updateCharacteristic(Characteristic.MotionDetected, state);
    }
  });

  eufyClient.on('device stranger person detected', (device, state) => {
    if (device.getSerial() === DEVICE_SERIAL) {
      log(`Stranger detected: ${state}`);
      if (state) { lastPersonTime = Date.now(); lastDetectionTime = Date.now(); event('stranger', null); scheduleSnapshotRefresh(); }
      personSensor.updateCharacteristic(Characteristic.MotionDetected, state);
    }
  });

  eufyClient.on('device property changed', (device, name, value) => {
    if (device.getSerial() !== DEVICE_SERIAL) return;
    // Cache raw snapshot JPEG from device
    if (name === 'picture') {
      if (value && value.data) {
        const buf = Buffer.from(value.data);
        if (buf.length > 100) {
          cachedSnapshot = buf;
          cachedSnapshotTime = Date.now();
          log(`Snapshot cached from picture property (${(buf.length / 1024).toFixed(0)}KB)`);
        }
      }
      return;
    }
    // Also cache cloud URL for fallback fetching
    if (name === 'pictureUrl') {
      if (value && typeof value === 'string' && value.startsWith('http')) {
        cachedSnapshotUrl = value;
        // Only fetch if we don't already have a recent snapshot (30s)
        if (!cachedSnapshot || (Date.now() - cachedSnapshotTime) > 30000) {
          fetchSnapshot(value).then((buf) => {
            if (buf) {
              cachedSnapshot = buf;
              cachedSnapshotTime = Date.now();
              log(`Snapshot cached from pictureUrl (${(buf.length / 1024).toFixed(0)}KB)`);
            }
          });
        }
      }
      return;
    }
    if (name === 'personName') {
      if (value && value !== '' && value !== 'Unknown') {
        log(`Face recognised: ${value}`);
        event('face', value);
      }
    }
  });

  eufyClient.on('device pet detected', (device, state) => {
    if (device.getSerial() === DEVICE_SERIAL) {
      log(`Pet detected: ${state}`);
      if (state) { lastDetectionTime = Date.now(); event('pet', null); }
      updateMotion(state);
      petSensor.updateCharacteristic(Characteristic.MotionDetected, state);
    }
  });

  // --- Livestream events ---

  eufyClient.on('station livestream start', async (station, device, metadata, videostream, audiostream) => {
    if (device.getSerial() !== DEVICE_SERIAL) return;

    log(`Livestream started — video: codec=${metadata.videoCodec} ${metadata.videoWidth}x${metadata.videoHeight}@${metadata.videoFPS}fps, audio: codec=${metadata.audioCodec}`);

    // Find the active session waiting for video data and pipe to its ffmpeg
    const sessionId = Object.keys(activeSessions).find(
      (id) => activeSessions[id].ffmpegProcess && !activeSessions[id].videoStream
    );

    // Snapshot-only grab (no HomeKit session) — grab one frame and stop
    if (!sessionId) {
      if (!snapshotGrabActive) {
        log('Livestream started but no active session — ignoring');
        return;
      }
      log('Snapshot grab — extracting frame from P2P stream');
      const grabFfmpeg = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'h264', '-i', 'pipe:0',
        '-vframes', '1', '-f', 'mjpeg', '-q:v', '5', '-',
      ], { stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks = [];
      grabFfmpeg.stdout.on('data', (c) => chunks.push(c));
      grabFfmpeg.on('close', (code) => {
        if (code === 0 && chunks.length) {
          cachedSnapshot = Buffer.concat(chunks);
          cachedSnapshotTime = Date.now();
          log(`Snapshot grabbed from P2P (${(cachedSnapshot.length / 1024).toFixed(0)}KB)`);
        }
        snapshotGrabActive = false;
        // Stop the P2P stream now we have our frame
        eufyClient.stopStationLivestream(DEVICE_SERIAL)
          .catch((err) => log(`Stop snapshot grab stream: ${err.message}`));
      });
      grabFfmpeg.on('error', () => { snapshotGrabActive = false; });
      grabFfmpeg.stdin.on('error', () => {});
      videostream.on('data', (chunk) => {
        if (grabFfmpeg.stdin.writable) grabFfmpeg.stdin.write(chunk);
      });
      videostream.on('end', () => {
        if (grabFfmpeg.stdin.writable) grabFfmpeg.stdin.end();
      });
      return;
    }

    const session = activeSessions[sessionId];
    const elapsed = session.streamStartTime ? Date.now() - session.streamStartTime : 0;
    log(`[${sessionId.substring(0, 8)}] +${elapsed}ms first video data arrived`);

    // Pipe video to video ffmpeg
    session.videoStream = videostream;

    // Also grab a snapshot from the first frame of a real stream
    const streamSnapshotFfmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'h264', '-i', 'pipe:0',
      '-vframes', '1', '-f', 'mjpeg', '-q:v', '5', '-',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    session.snapshotFfmpeg = streamSnapshotFfmpeg;
    const ssChunks = [];
    streamSnapshotFfmpeg.stdout.on('data', (c) => ssChunks.push(c));
    streamSnapshotFfmpeg.on('close', (code) => {
      if (code === 0 && ssChunks.length) {
        cachedSnapshot = Buffer.concat(ssChunks);
        cachedSnapshotTime = Date.now();
        log(`Snapshot grabbed from livestream (${(cachedSnapshot.length / 1024).toFixed(0)}KB)`);
      }
      if (session.snapshotFfmpeg === streamSnapshotFfmpeg) session.snapshotFfmpeg = null;
    });
    streamSnapshotFfmpeg.on('error', () => {});
    streamSnapshotFfmpeg.stdin.on('error', () => {});

    videostream.on('data', (chunk) => {
      if (session.ffmpegProcess && session.ffmpegProcess.stdin.writable) {
        if (!session.ffmpegProcess.stdin.write(chunk) && !session._bpWarned) {
          session._bpWarned = true;
          log(`[${sessionId.substring(0, 8)}] ffmpeg stdin backpressure — data buffering`);
        }
      }
      // Feed snapshot grabber until it's got its frame
      if (streamSnapshotFfmpeg.stdin.writable) {
        streamSnapshotFfmpeg.stdin.write(chunk);
      }
    });

    videostream.on('end', () => {
      log('Video stream ended');
      if (streamSnapshotFfmpeg.stdin.writable) streamSnapshotFfmpeg.stdin.end();
    });

    videostream.on('error', (err) => {
      log(`Video stream error: ${err.message}`);
    });

    // Pipe audio to audio ffmpeg
    if (audiostream && session.audioFfmpegProcess) {
      session.audioStream = audiostream;

      audiostream.on('data', (chunk) => {
        if (session.audioFfmpegProcess && session.audioFfmpegProcess.stdin.writable) {
          session.audioFfmpegProcess.stdin.write(chunk);
        }
      });

      audiostream.on('end', () => {
        log('Audio stream ended');
      });

      audiostream.on('error', (err) => {
        log(`Audio stream error: ${err.message}`);
      });
    } else {
      log('No audio stream or audio ffmpeg — audio disabled for this session');
    }

    // Start talkback — fire and forget, don't block the video path
    eufyClient.startStationTalkback(DEVICE_SERIAL)
      .then(() => log('Talkback requested'))
      .catch((err) => log(`Talkback start failed: ${err.message}`));
  });

  eufyClient.on('station talkback start', (station, device, talkbackStream) => {
    if (device.getSerial() !== DEVICE_SERIAL) return;
    log('Talkback started — setting up return audio');

    // Find active session
    const sessionId = Object.keys(activeSessions).find(
      (id) => activeSessions[id].ffmpegProcess && !activeSessions[id].talkbackActive
    );

    if (!sessionId) {
      log('Talkback started but no session waiting for it');
      return;
    }

    const session = activeSessions[sessionId];
    const sid = sessionId.substring(0, 8);
    session.talkbackActive = true;
    session.talkbackStream = talkbackStream;

    // Spawn return audio ffmpeg now (deferred from stream start to keep video path fast)
    // Receive SRTP from HomeKit mic → decode AAC-ELD → encode AAC-LC ADTS
    const pt = session.audioPt;
    const sdpContent = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=HomeKit Return Audio',
      'c=IN IP4 127.0.0.1',
      `m=audio ${session.audioReturnPort} RTP/SAVP ${pt}`,
      `a=rtpmap:${pt} MPEG4-GENERIC/16000/1`,
      `a=fmtp:${pt} profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=F8F02000`,
      `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${session.audioSRTP.toString('base64')}`,
    ].join('\r\n');

    const sdpPath = `/tmp/doorbell-return-audio-${sid}.sdp`;
    fs.writeFileSync(sdpPath, sdpContent);

    const returnAudioArgs = [
      '-hide_banner', '-loglevel', 'warning',
      '-acodec', 'libfdk_aac',
      '-protocol_whitelist', 'file,crypto,udp,rtp',
      '-f', 'sdp', '-i', sdpPath,
      '-codec:a', 'libfdk_aac', '-profile:a', 'aac_low',
      '-ar', '16000', '-ac', '1', '-b:a', '24k',
      '-f', 'adts', 'pipe:1',
    ];

    const returnAudioFfmpeg = spawn('/usr/local/bin/ffmpeg-hk', returnAudioArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    returnAudioFfmpeg.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) log(`ffmpeg-return[${sid}]: ${msg}`);
    });

    returnAudioFfmpeg.on('close', (code) => {
      log(`ffmpeg-return exited with code ${code} for session ${sid}`);
      try { fs.unlinkSync(sdpPath); } catch (e) {}
    });

    returnAudioFfmpeg.on('error', (err) => {
      log(`ffmpeg-return spawn error: ${err.message}`);
    });

    session.returnAudioFfmpeg = returnAudioFfmpeg;

    // Pipe decoded AAC-LC from return audio ffmpeg → eufy talkback stream
    returnAudioFfmpeg.stdout.on('data', (chunk) => {
      if (session.talkbackStream && session.talkbackStream.writable) {
        try { session.talkbackStream.write(chunk); } catch (e) {}
      }
    });

    returnAudioFfmpeg.stdout.on('error', () => {});
    log('Talkback piping active');
  });

  eufyClient.on('station talkback stop', (station, device) => {
    if (device.getSerial() !== DEVICE_SERIAL) return;
    log('Talkback stopped by station');
  });

  eufyClient.on('station talkback error', (station, device, error) => {
    if (device.getSerial() !== DEVICE_SERIAL) return;
    log(`Talkback error: ${error.message}`);
  });

  eufyClient.on('station livestream stop', (station, device) => {
    if (device.getSerial() !== DEVICE_SERIAL) return;
    log('P2P livestream stopped by station — cleaning up sessions');
    for (const sessionId of Object.keys(activeSessions)) {
      if (activeSessions[sessionId].videoStream) {
        stopStream(sessionId);
        doorbellController.forceStopStreamingSession(sessionId);
      }
    }
  });

  // --- Connect ---

  await eufyClient.connect();
  log('Eufy client connected');
}

function updateMotion(state) {
  const motionService = doorbellController.motionService;
  if (motionService) {
    motionService.updateCharacteristic(Characteristic.MotionDetected, state);
  }
}

function scheduleReconnect(reason) {
  if (reconnectTimer || reconnecting) return; // already scheduled or in progress
  log(`Scheduling reconnect in ${reconnectDelay}s (triggered by: ${reason})`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (reconnecting) return;
    try {
      if (eufyClient) {
        reconnecting = true;
        log('Attempting Eufy reconnect...');
        await eufyClient.connect();
        log('Eufy reconnected');
        reconnecting = false;
      }
    } catch (err) {
      reconnecting = false;
      reconnectDelay = Math.min(reconnectDelay * 2, 60);
      log(`Reconnect failed: ${err.message}`);
      scheduleReconnect('retry');
    }
  }, reconnectDelay * 1000);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  log(`Received ${signal} — shutting down`);

  // Safety net: force exit after 5s if cleanup hangs
  setTimeout(() => { log('Shutdown timeout — forcing exit'); process.exit(1); }, 5000).unref();

  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (snapshotRefreshTimer) { clearTimeout(snapshotRefreshTimer); snapshotRefreshTimer = null; }
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (cloudRefreshInterval) { clearInterval(cloudRefreshInterval); cloudRefreshInterval = null; }
  if (snapshotGrabInterval) { clearInterval(snapshotGrabInterval); snapshotGrabInterval = null; }
  if (pushWatchdogInterval) { clearInterval(pushWatchdogInterval); pushWatchdogInterval = null; }

  for (const sessionId of Object.keys(activeSessions)) {
    stopStream(sessionId);
  }

  if (eufyClient) {
    try { eufyClient.close(); } catch (e) { /* ignore */ }
  }

  try { accessory.unpublish(); } catch (e) { /* ignore */ }
  try { db.close(); } catch (e) { /* ignore */ }

  log('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  log('=== Doorbell service starting ===');

  try {
    await initEufy();

    await accessory.publish({
      username: HOMEKIT_USERNAME,
      pincode: HOMEKIT_PIN,
      port: HOMEKIT_PORT,
      category: Categories.VIDEO_DOORBELL,
    });

    log(`HomeKit accessory published on port ${HOMEKIT_PORT}`);
    log('=== Doorbell service ready ===');

    // Heartbeat — log status every hour so we can verify the system is alive
    heartbeatInterval = setInterval(() => {
      const sessions = Object.keys(activeSessions).length;
      const uptime = Math.floor(process.uptime() / 3600);
      log(`HEARTBEAT — uptime: ${uptime}h, device: ${eufyDevice ? 'connected' : 'MISSING'}, sessions: ${sessions}`);
      event('heartbeat', null, { uptime_hours: uptime, device: !!eufyDevice, sessions });
    }, 3600000);

    // Refresh cloud data every 3 hours to keep push registration alive
    cloudRefreshInterval = setInterval(async () => {
      try {
        log('Refreshing cloud data...');
        await eufyClient.refreshCloudData();
        log('Cloud data refreshed');
      } catch (err) {
        log(`Cloud refresh failed: ${err.message}`);
        scheduleReconnect('cloud refresh failed');
      }
    }, 3 * 3600000);

    // Periodic snapshot grab — start a quick P2P stream every 60s to get a fresh frame
    // Pauses for 10 min after person/ring detection to hold onto that event image
    snapshotGrabInterval = setInterval(async () => {
      // Skip if there's an active/pending HomeKit stream or another grab in progress
      if (Object.keys(activeSessions).length > 0 || snapshotGrabActive || streamPending) return;
      if (!eufyClient || !eufyDevice) return;
      // Hold person/ring snapshot for 10 minutes
      if ((Date.now() - lastPersonTime) < PERSON_HOLD) return;
      try {
        snapshotGrabActive = true;
        log('Snapshot grab — starting quick P2P stream');
        await eufyClient.startStationLivestream(DEVICE_SERIAL);
        // Timeout safety: if no data arrives in 10s, cancel
        setTimeout(() => {
          if (snapshotGrabActive) {
            log('Snapshot grab — timeout, stopping');
            snapshotGrabActive = false;
            eufyClient.stopStationLivestream(DEVICE_SERIAL).catch(() => {});
          }
        }, 10000);
      } catch (err) {
        log(`Snapshot grab failed: ${err.message}`);
        snapshotGrabActive = false;
      }
    }, 60000);

    // Push health watchdog — if no detection events for 4h during daytime, force reconnect
    pushWatchdogInterval = setInterval(() => {
      const hour = new Date().getHours();
      if (hour < 6 || hour >= 23) return; // skip overnight
      const silenceHours = (Date.now() - lastDetectionTime) / 3600000;
      if (silenceHours >= 4) {
        log(`WATCHDOG — no detection events for ${silenceHours.toFixed(1)}h, forcing reconnect`);
        lastDetectionTime = Date.now(); // reset so we don't spam reconnects
        scheduleReconnect('push watchdog');
      }
    }, 1800000); // check every 30 min
  } catch (err) {
    log(`FATAL: ${err.message}`);
    log(err.stack);
    process.exit(1);
  }
})();
