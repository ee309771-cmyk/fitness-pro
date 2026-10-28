import React, { useEffect, useRef, useState } from 'react';
import { isVisible } from '../analysis/bench.mjs';

const edges = [[11,13],[13,15],[12,14],[14,16],[11,12],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
export function nearestFrame(frames, time) {
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (frames[mid].time < time) lo = mid + 1; else hi = mid; }
  return lo > 0 && Math.abs(frames[lo - 1].time - time) < Math.abs(frames[lo].time - time) ? frames[lo - 1] : frames[lo];
}

export function Skeleton({ report, time }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !report.frames.length) return;
    const frame = nearestFrame(report.frames, time);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (Math.abs(frame.time - time) > 0.3) return;
    const points = frame.landmarks;
    if (!points) return;
    const ids = report.side === 'left' ? [11,13,15] : [12,14,16];
    const x = p => p.x * canvas.width, y = p => p.y * canvas.height;
    ctx.lineCap = 'round';
    for (const [a,b] of edges) {
      if (![points[a], points[b]].every(isVisible)) continue;
      ctx.strokeStyle = ids.includes(a) && ids.includes(b) ? '#dcf497' : '#83c5bb';
      ctx.lineWidth = canvas.width / 220;
      ctx.beginPath(); ctx.moveTo(x(points[a]),y(points[a])); ctx.lineTo(x(points[b]),y(points[b])); ctx.stroke();
    }
    ids.forEach(i => {
      if (!isVisible(points[i])) return;
      ctx.fillStyle = '#dcf497'; ctx.beginPath(); ctx.arc(x(points[i]),y(points[i]),canvas.width/130,0,Math.PI*2);ctx.fill();
    });
    if (frame.visible && Number.isFinite(frame.angle)) {
      const elbow = points[ids[1]];
      ctx.font = `600 ${Math.max(16, canvas.width / 35)}px sans-serif`;
      ctx.lineWidth = 4; ctx.strokeStyle = '#152b30';
      ctx.strokeText(`${Math.round(frame.angle)}°`,x(elbow)+14,y(elbow)-14);
      ctx.fillStyle = '#fff';ctx.fillText(`${Math.round(frame.angle)}°`,x(elbow)+14,y(elbow)-14);
    }
  }, [report,time]);
  return <canvas ref={ref} width={report.metadata.width} height={report.metadata.height} className="skeleton" aria-label="可见关节骨架叠加" />;
}

export function VideoReview({ report, file, time, onTime, seekTo, compact = false }) {
  const video = useRef(null);
  const [url,setUrl] = useState('');
  const [playing,setPlaying] = useState(false);
  const [speed,setSpeed] = useState(1);
  const [playbackError,setPlaybackError] = useState(false);
  useEffect(() => {
    setPlaybackError(false);
    if (!file) { setUrl(''); return; }
    const value = URL.createObjectURL(file);setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  useEffect(() => {
    if (Number.isFinite(seekTo?.time)) {
      setPlaying(false);
      if (video.current) { video.current.pause();video.current.currentTime = seekTo.time; }
      onTime(seekTo.time);
    }
  }, [seekTo]);
  useEffect(() => {
    if (url || !playing) return;
    let handle, last = performance.now();
    const tick = now => { const delta = (now - last) / 1000;last = now;onTime(t => t + delta * speed >= report.metadata.duration ? 0 : t + delta * speed);handle = requestAnimationFrame(tick); };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing,url,speed,report.metadata.duration,onTime]);
  return <div className={compact ? 'review compact' : 'review'}>
    <div className="video-stage" style={{ aspectRatio: `${report.metadata.width}/${report.metadata.height}`, maxWidth: `${(compact ? 300 : 560) * report.metadata.width / report.metadata.height}px` }}>
      {url ? <video ref={video} src={url} playsInline controls muted preload="metadata" onTimeUpdate={e => onTime(e.currentTarget.currentTime)} onError={() => {setPlaying(false);setPlaybackError(true);}} /> : <div className="synthetic-bg"><span>{report.metadata.source === 'synthetic' ? '合成动作示意 · 非实拍视频' : '骨架回放 · 此记录未保存原视频'}</span><div className="bench-line" /></div>}
      <Skeleton report={report} time={time} />
      <span className="stage-label">{report.side === 'left' ? '左侧' : '右侧'}关节 · {time.toFixed(1)} s</span>
    </div>
    {playbackError&&<p className="message error">当前浏览器无法回放此编码，骨架仍可拖动查看。建议将视频转为 MP4/H.264 后重试。</p>}
    <div className="playback-tools">
      {!url && <button className="text-button" onClick={() => setPlaying(p => !p)}>{playing ? '暂停' : '播放示意'}</button>}
      <input aria-label="复盘时间" type="range" min="0" max={report.metadata.duration} step="0.05" value={Math.min(time,report.metadata.duration)} onChange={e => { const t = +e.target.value;onTime(t);if(video.current)video.current.currentTime=t; }} />
      <select aria-label="回放速度" value={speed} onChange={e => {setSpeed(+e.target.value);if(video.current)video.current.playbackRate=+e.target.value;}}><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1">1×</option></select>
    </div>
  </div>;
}

export function AngleChart({ report, time, onSeek }) {
  const W=720,H=170,P=28;
  const x=t=>P+t/report.metadata.duration*(W-P*2),y=a=>H-P-a/180*(H-P*2);
  let path='',open=false;
  for(const f of report.frames){if(f.angle==null){open=false;continue;}path+=`${open?'L':'M'}${x(f.time).toFixed(1)},${y(f.angle).toFixed(1)} `;open=true;}
  return <div className="chart"><div className="section-line"><h3>肘部角度</h3><span>画面投影角度 · 拖动视频查看</span></div><svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="肘角随时间变化曲线" onClick={e=>{const r=e.currentTarget.getBoundingClientRect();onSeek(Math.max(0,Math.min(report.metadata.duration,((e.clientX-r.left)/r.width*W-P)/(W-P*2)*report.metadata.duration)));}}>
    {[0,90,180].map(a=><g key={a}><line x1={P} x2={W-P} y1={y(a)} y2={y(a)} stroke="#e7eae0"/><text x="0" y={y(a)+4} fontSize="11" fill="#8b968f">{a}°</text></g>)}
    {report.reps.filter(r=>r.enabled).map((r,i)=><rect key={i} x={x(r.start)} y={P} width={Math.max(1,x(r.end)-x(r.start))} height={H-P*2} fill={i%2?'#edf3e2':'#f3f6ed'}/>)}
    <path d={path} fill="none" stroke="#376d61" strokeWidth="2.5"/><line x1={x(time)} x2={x(time)} y1="15" y2={H-P} stroke="#b49851" strokeDasharray="4 4"/>
  </svg></div>;
}
