const express = require('express');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const TMP_DIR = '/tmp/ffmpeg';
const RESULTS_DIR = '/tmp/results';

fsp.mkdir(TMP_DIR, { recursive: true }).catch(() => {});
fsp.mkdir(RESULTS_DIR, { recursive: true }).catch(() => {});

const JOBS = new Map();

// ── Auth middleware ─────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (!AUTH_TOKEN) return next(); // no token set = open (not recommended)
  const hdr = req.headers.authorization || '';
  if (hdr === `Bearer ${AUTH_TOKEN}`) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function downloadFile(url, dest, onProgress) {
  const res = await axios.get(url, { responseType: 'stream', timeout: 180000, maxContentLength: Infinity });
  const writer = fs.createWriteStream(dest);
  let downloaded = 0;
  res.data.on('data', chunk => { downloaded += chunk.length; });
  res.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
    res.data.on('error', reject);
  });
}

function probeMedia(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath], (err, stdout) => {
      if (err) return resolve({ hasAudio: false });
      try {
        const data = JSON.parse(stdout);
        const streams = data.streams || [];
        resolve({ hasAudio: streams.some(s => s.codec_type === 'audio') });
      } catch { resolve({ hasAudio: false }); }
    });
  });
}

function fmtTime(sec) { return Number(sec).toFixed(3); }

function srtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

function buildSRT(subtitles) {
  let srt = '';
  subtitles.forEach((entry, i) => {
    srt += `${i + 1}\n${srtTime(entry.start)} --> ${srtTime(entry.end)}\n${entry.text}\n\n`;
  });
  return srt;
}

function parseTimeToSec(timeStr) {
  const parts = timeStr.split(':').map(parseFloat);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// ── Main render ─────────────────────────────────────────────────────────────
async function renderJob(job) {
  const { timeline, dir } = job;
  const { clips, audio_track, subtitles, aspect_ratio = '16:9', fps = 30 } = timeline;

  const resMap = {
    '16:9': { w: 1280, h: 720 },
    '9:16': { w: 720, h: 1280 },
    '1:1': { w: 1080, h: 1080 },
    '4:3': { w: 1440, h: 1080 },
    '4:5': { w: 1080, h: 1350 },
  };
  const res = resMap[aspect_ratio] || resMap['16:9'];

  // Phase 1: Download clips
  job.status = 'downloading';
  const clipFiles = [];
  for (let i = 0; i < clips.length; i++) {
    const clipPath = path.join(dir, `clip_${i}.${clips[i].url.match(/\.(mp4|mov|webm|mkv)/i)?.[0]?.slice(1) || 'mp4'}`);
    await downloadFile(clips[i].url, clipPath);
    clipFiles.push(clipPath);
    job.progress = Math.round(((i + 1) / clips.length) * 20);
  }

  // Download audio
  let audioPath = null;
  if (audio_track?.url) {
    audioPath = path.join(dir, 'audio.mp3');
    await downloadFile(audio_track.url, audioPath);
  }

  // Phase 2: Probe
  const probes = await Promise.all(clipFiles.map(f => probeMedia(f)));

  // Phase 3: Build FFmpeg command
  job.status = 'rendering';
  job.progress = 25;

  const inputs = [];
  const noAudioClips = [];

  clips.forEach((clip, i) => {
    inputs.push('-ss', fmtTime(clip.trim_start || 0), '-i', clipFiles[i]);
    if (!probes[i].hasAudio) noAudioClips.push(i);
  });

  // anullsrc for clips without audio
  noAudioClips.forEach((clipIdx) => {
    const dur = clips[clipIdx].duration || 5;
    inputs.push('-f', 'lavfi', '-t', fmtTime(dur), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  });

  // audio track input
  if (audioPath) inputs.push('-i', audioPath);

  // Build filter graph
  const filters = [];
  const anullsrcBase = clips.length;

  clips.forEach((clip, i) => {
    const dur = clip.duration || 5;
    const fadeOut = Math.max(0.01, dur - 0.25);

    filters.push(
      `[${i}:v]trim=duration=${fmtTime(dur)},` +
      `format=pix_fmts=yuv420p,` +
      `scale=${res.w}:${res.h}:force_original_aspect_ratio=increase:force_divisible_by=2,` +
      `crop=${res.w}:${res.h},setsar=1,` +
      `fade=t=in:st=0:d=0.25,fade=t=out:st=${fmtTime(fadeOut)}:d=0.25,` +
      `fps=${fps}[v${i}]`
    );

    if (probes[i].hasAudio) {
      filters.push(
        `[${i}:a]atrim=duration=${fmtTime(dur)},asetpts=N/SR/TB,` +
        `afade=t=in:st=0:d=0.25,afade=t=out:st=${fmtTime(fadeOut)}:d=0.25[a${i}]`
      );
    } else {
      const idx = anullsrcBase + noAudioClips.indexOf(i);
      filters.push(`[${idx}:a]atrim=duration=${fmtTime(dur)},asetpts=N/SR/TB[a${i}]`);
    }
  });

  // Concat
  const concatInputs = clips.map((_, i) => `[v${i}][a${i}]`).join('');
  filters.push(`${concatInputs}concat=n=${clips.length}:v=1:a=1[vcat][acat]`);

  let videoOut = '[vcat]';
  let audioOut = '[acat]';

  // Audio overlay
  if (audioPath) {
    const audioIdx = clips.length + noAudioClips.length;
    const vol = audio_track.volume ?? 0.8;
    const delayMs = Math.round((audio_track.start || 0) * 1000);
    const trimStart = audio_track.trim || 0;
    filters.push(
      `[${audioIdx}:a]atrim=${fmtTime(trimStart)},volume=${vol},adelay=${delayMs}|${delayMs}[aover]`
    );
    filters.push(`[acat][aover]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
    audioOut = '[aout]';
  }

  // Subtitles
  if (subtitles && subtitles.length > 0) {
    const srtContent = buildSRT(subtitles);
    const srtPath = path.join(dir, 'subtitles.srt');
    await fsp.writeFile(srtPath, srtContent, 'utf-8');
    const escaped = srtPath.replace(/'/g, "\\'").replace(/:/g, '\\:');
    filters.push(
      `[vcat]subtitles='${escaped}':force_style='FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=40'[vsub]`
    );
    videoOut = '[vsub]';
  }

  const outputPath = path.join(RESULTS_DIR, `${job.id}.mp4`);

  const args = [
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', videoOut,
    '-map', audioOut,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];

  console.log(`[Job ${job.id}] Starting FFmpeg with ${clips.length} clips`);

  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', (data) => {
      stderr += data.toString();
      const m = stderr.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (m) {
        const rendered = parseTimeToSec(m[1]);
        job.progress = Math.min(95, 25 + Math.round(70 * (rendered / job.totalDuration)));
      }
    });
    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg code ${code}: ${stderr.slice(-800)}`));
    });
    ff.on('error', reject);
  });

  job.status = 'completed';
  job.progress = 100;
  job.resultUrl = `/results/${job.id}.mp4`;
  console.log(`[Job ${job.id}] Completed: ${outputPath}`);

  // Cleanup
  try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
}

// ── Routes ──────────────────────────────────────────────────────────────────
app.post('/render', auth, async (req, res) => {
  try {
    const { clips, audio_track, subtitles, aspect_ratio } = req.body;
    if (!clips || clips.length === 0) return res.status(400).json({ error: 'No clips' });

    const jobId = crypto.randomUUID();
    const jobDir = path.join(TMP_DIR, jobId);
    await fsp.mkdir(jobDir, { recursive: true });

    const totalDuration = clips.reduce((s, c) => s + (c.duration || 5), 0);

    const job = {
      id: jobId,
      status: 'pending',
      progress: 0,
      error: null,
      resultUrl: null,
      dir: jobDir,
      timeline: req.body,
      totalDuration,
      createdAt: Date.now(),
    };
    JOBS.set(jobId, job);

    renderJob(job).catch(err => {
      console.error(`[Job ${jobId}] FAILED:`, err.message);
      job.status = 'failed';
      job.error = err.message;
    });

    res.json({ job_id: jobId, status: 'pending' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/status/:jobId', auth, (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    status: job.status,
    progress: Math.round(job.progress),
    error: job.error,
    result_url: job.resultUrl,
  });
});

app.get('/results/:file', (req, res) => {
  const filePath = path.join(RESULTS_DIR, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(filePath);
});

app.delete('/cleanup/:jobId', auth, async (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (job) {
    const filePath = path.join(RESULTS_DIR, `${job.id}.mp4`);
    try { await fsp.unlink(filePath); } catch {}
    try { await fsp.rm(job.dir, { recursive: true, force: true }); } catch {}
    JOBS.delete(req.params.jobId);
  }
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, jobs: JOBS.size });
});

// Cleanup old jobs (every 30 min)
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (now - job.createdAt > 2 * 60 * 60 * 1000) { // 2 hours
      const fp = path.join(RESULTS_DIR, `${id}.mp4`);
      try { fs.unlinkSync(fp); } catch {}
      try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch {}
      JOBS.delete(id);
    }
  }
}, 30 * 60 * 1000);

app.listen(PORT, () => console.log(`FFmpeg render server on :${PORT}`));
