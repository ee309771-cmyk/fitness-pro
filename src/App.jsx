import React, { useEffect, useMemo, useRef, useState } from 'react';
import { analyzeBench, median, repFromBounds } from './analysis/bench.mjs';
import { createDemo } from './analysis/demo.mjs';
import { compareRep, referenceTimeAt, summarizeDifferences } from './analysis/compare.mjs';
import { readVideo } from './services/video.mjs';
import { saveSession, listSessions, deleteSession } from './services/history.mjs';
import { VideoReview, AngleChart } from './components/Review.jsx';

const fmt = (n,unit='') => Number.isFinite(n) ? `${n.toFixed(1)}${unit}` : '—';
const instructions = [
  ['固定侧拍','手机放在稳固支架上，镜头朝向身体侧面。肩、肘、腕完整入镜，尽量避开杠铃片遮挡。'],
  ['一组一个视频','首版支持 2 分钟、250 MB 以内的视频。画面水平、光线均匀，尽量只拍到一位训练者。'],
  ['先看画面，再看数字','识别不到的关节会留空。自动计次待你复核，角度是画面投影值，不能代表实际关节受力。'],
];
function downloadReport(report) {
  const { frames, referenceSnapshot, ...summary } = report;
  const blob = new Blob([JSON.stringify({ ...summary, automaticSegments:report.reps.length, finalCount:report.countOverride??report.reps.filter(r=>r.enabled).length, countSource:report.countOverride!=null?'manual':'automatic-proposal' },null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`fitness-pro-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function BenchDrawing() {
  return <svg className="hero-drawing" viewBox="0 0 480 280" role="img" aria-label="固定侧拍卧推的关节示意">
    <defs><pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M 30 0 L 0 0 0 30" fill="none" stroke="#dce4d5" strokeWidth="0.5"/></pattern></defs><rect width="480" height="280" fill="url(#grid)"/>
    <path d="M60 210H430M94 187H320M113 190V210M302 190V210" stroke="#bcc8b8" strokeWidth="6" strokeLinecap="round"/>
    <path d="M140 167L268 180L343 198L373 231M187 172L224 130L228 60" fill="none" stroke="#375e57" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round"/>
    <circle cx="117" cy="160" r="19" fill="#375e57"/><path d="M201 57H264M208 43V72M257 43V72" stroke="#152b30" strokeWidth="6" strokeLinecap="round"/>
    <path d="M228 62Q242 99 224 130" fill="none" stroke="#9bb05e" strokeWidth="2" strokeDasharray="5 5"/>
    {[[187,172],[224,130],[228,60]].map(([x,y])=><circle key={y} cx={x} cy={y} r="7" fill="#d6ed94" stroke="#152b30" strokeWidth="2"/>)}
    <g fill="#607b6e" fontFamily="sans-serif" fontSize="11"><text x="152" y="197">肩</text><text x="246" y="135">肘</text><text x="278" y="64">腕</text><text x="340" y="36" letterSpacing="2">SIDE VIEW</text></g>
    <path d="M75 44v-12h12M403 44v-12h-12M75 242v12h12M403 242v12h-12" fill="none" stroke="#a5b897"/>
  </svg>;
}
export default function App() {
  const [page,setPage]=useState('work'),[report,setReport]=useState(null),[file,setFile]=useState(null);
  const [reference,setReference]=useState(null),[referenceFile,setReferenceFile]=useState(null),[referenceIndex,setReferenceIndex]=useState(0);
  const [time,setTime]=useState(0),[seek,setSeek]=useState(null),[refTime,setRefTime]=useState(0),[refSeek,setRefSeek]=useState(null);
  const [selected,setSelected]=useState(0),[progress,setProgress]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [history,setHistory]=useState([]),[keepVideo,setKeepVideo]=useState(false),[bounds,setBounds]=useState({start:0,bottom:1,end:2});
  const controller=useRef(null),section=useRef(null);
  useEffect(()=>()=>controller.current?.abort(),[]);
  const refresh=()=>listSessions().then(setHistory).catch(e=>setError(e.message));
  useEffect(()=>{if(page==='history')refresh();},[page]);
  const jump=t=>{setSeek({time:t,id:Date.now()});setTime(t);};
  const resetReport=(next,nextFile)=>{setReport(next);setFile(nextFile);setTime(0);setSelected(0);setPage('work');setSeek({time:0,id:Date.now()});if(next?.referenceSnapshot){setReference(next.referenceSnapshot.report);setReferenceIndex(next.referenceSnapshot.index);setReferenceFile(null);}};
  const runFile=async(event,target='attempt')=>{
    const chosen=event.target.files?.[0];event.target.value='';if(!chosen)return;
    if(!chosen.type.startsWith('video/')&&!/\.(mp4|mov|m4v|webm)$/i.test(chosen.name)){setError('请选择视频文件');return;}
    setError('');setNotice('');controller.current?.abort();const abort=new AbortController();controller.current=abort;
    try{
      setProgress({percent:0,phase:target==='reference'?'正在读取参考视频':'正在准备视频'});
      const read=await readVideo(chosen,{signal:abort.signal,onProgress:setProgress});
      const next=analyzeBench(read.samples,read.metadata);
      if(target==='reference'){setReference(next);setReferenceFile(chosen);setReferenceIndex(0);setNotice(next.reps.length?'参考视频已读取，请选择一次完整动作':'参考视频未找到完整动作。可先将它作为训练视频导入，手动标注后设为参考。');}
      else resetReport(next,chosen);
    }catch(e){if(e.name!=='AbortError')setError(e.message||'分析未完成，请尝试 MP4/H.264 视频');else setNotice('已取消分析');}
    finally{setProgress(null);controller.current=null;}
  };
  const demo=()=>{
    const d=createDemo(),r=analyzeBench(d.samples,d.metadata);resetReport(r,null);
    const rd=createDemo({reps:1,depth:80});setReference(analyzeBench(rd.samples,rd.metadata));setReferenceFile(null);setReferenceIndex(0);
    setNotice('当前为合成动作示意，用于体验流程；不能证明实拍识别或纠偏准确率。');setError('');
  };
  const active=report?.reps.filter(r=>r.enabled)??[];
  const comparisons=useMemo(()=>!report||!reference?[]:report.reps.map((rep,index)=>({index,result:rep.enabled?compareRep(report,rep,reference,reference.reps[referenceIndex]):{status:'unavailable',reason:'已排除此段'}})),[report,reference,referenceIndex]);
  const comparison=comparisons[selected]?.result;
  const hints=useMemo(()=>summarizeDifferences(comparisons),[comparisons]);
  useEffect(()=>{
    const t=referenceTimeAt(comparison,time);if(t!=null){setRefTime(t);setRefSeek({time:t,id:time});}
  },[time,comparison]);
  useEffect(()=>{
    const r=report?.reps[selected];if(r)setBounds({start:+r.start.toFixed(2),bottom:+r.bottom.toFixed(2),end:+r.end.toFixed(2)});
    else if(report)setBounds({start:0,bottom:+(report.metadata.duration/2).toFixed(2),end:+report.frames.at(-1).time.toFixed(2)});
  },[selected,report?.metadata.name]);
  const changeSide=e=>{
    const next=analyzeBench(report.frames.map(f=>({time:f.time,landmarks:f.landmarks})),report.metadata,e.target.value);
    resetReport(next,file);setNotice('已按所选侧面重新分析；请重新复核动作分段。');
  };
  const editRep=(index,changes)=>setReport(r=>({...r,reps:r.reps.map((p,i)=>i===index?{...p,...changes}:p)}));
  const applyBounds=add=>{
    try{const rep=repFromBounds(report.frames,+bounds.start,+bounds.bottom,+bounds.end,'manual');setReport(r=>({...r,reps:add?[...r.reps,rep].sort((a,b)=>a.start-b.start):r.reps.map((p,i)=>i===selected?rep:p)}));setNotice('已保存手动分段，报告保留手动来源。');setError('');}
    catch(e){setError(e.message);}
  };
  const save=async()=>{
    try{
      const {referenceSnapshot:old,comparisonSummary:previous,...referenceReport}=reference??{};
      const snapshot=reference?{report:referenceReport,index:referenceIndex}:null;
      const summary=comparisons.map(({index,result})=>{const{mapping,...details}=result;return{index,...details};});
      const saved={...report,referenceSnapshot:snapshot,comparisonSummary:summary};
      const id=await saveSession(saved,keepVideo?file:null);setReport({...saved,id});setNotice(keepVideo?'已将复盘和视频保存到当前浏览器':'已保存关节、参考对比与指标；再次播放原视频需重新导入');
    }
    catch(e){setError(e.message);}
  };
  return <main className="shell">
    <header className="topbar"><a className="brand" href="#" onClick={e=>{e.preventDefault();setPage('work');}}>FP<span>FITNESS PRO</span></a><nav aria-label="主导航"><button className={page==='work'?'nav active':'nav'} onClick={()=>setPage('work')}>动作复盘</button><button className={page==='history'?'nav active':'nav'} onClick={()=>setPage('history')}>训练记录</button><button className={page==='guide'?'nav active':'nav'} onClick={()=>setPage('guide')}>拍摄指南</button></nav><span className="privacy"><i/>本机分析</span></header>
    {page==='work'&&<>
      {!report&&<section className="hero hero-grid"><div><span className="eyebrow">MOVE WITH INTENTION / 每一次，都有依据</span><h1>把训练，<br/>练得更明白<span>。</span></h1><p>一组卧推，一次认真复盘。看清关节轨迹，找到与参考动作的差异。</p><div className="hero-tags"><span className="pill">01 卧推</span><span>固定侧拍</span><span>视频留在本机</span></div></div><div className="drawing-card"><BenchDrawing/><span className="drawing-caption">看见肩、肘、腕的每一次配合</span></div></section>}
      <section className="workspace" ref={section}>
        <div className="section-title"><div><span className="eyebrow">YOUR WORKSPACE</span><h2>{report?'这组动作，值得仔细看':'从一组训练开始'}</h2></div>{report&&<button className="secondary" disabled={!!progress} onClick={()=>{resetReport(null,null);setNotice('');}}>＋ 分析新一组</button>}<span className="experiment">卧推分析 · 实验版</span></div>
        {error&&<div className="message error" role="alert">{error}<button aria-label="关闭错误" onClick={()=>setError('')}>×</button></div>}
        {notice&&<div className="message" role="status">{notice}<button aria-label="关闭提示" onClick={()=>setNotice('')}>×</button></div>}
        {progress&&<div className="panel progress-panel" role="status"><div><strong>{progress.phase}</strong><span>{progress.percent}%</span></div><progress max="100" value={progress.percent}/><p>视频正在设备上处理。请保持页面打开。</p><button className="text-button" onClick={()=>controller.current?.abort()}>取消本次分析</button></div>}
        {!report&&<div className="start-grid"><section className="panel upload-card"><div className="step-label">01 / 记录你的动作</div><label className={`drop-zone ${progress?'disabled':''}`}><span className="upload-icon">↥</span><strong>拍摄或选择卧推视频</strong><span>MP4、MOV 或 WebM · 最多 2 分钟 / 250 MB</span><span className="primary visual-button">选择本机视频 <b>↗</b></span><input aria-label="选择训练视频" type="file" accept="video/*,.mov,.mp4,.m4v" disabled={!!progress} onChange={runFile}/></label><div className="upload-bottom"><span>全程本地处理，无需上传</span><button className="text-button" onClick={demo} disabled={!!progress}>先体验演示 →</button></div></section><aside className="panel filming-card"><span className="step-label">拍得清楚，才看得明白</span><h3>开始前，花 10 秒<br/>调整一下机位。</h3>{instructions.slice(0,2).map(([title,body],i)=><div className="tip" key={title}><span>0{i+1}</span><div><strong>{title}</strong><p>{body}</p></div></div>)}<button className="text-button" onClick={()=>setPage('guide')}>查看完整拍摄指南 ↗</button></aside></div>}
        {report&&<>
          <div className="report-heading"><div><span className="pill">{report.metadata.source==='synthetic'?'合成演示':'平板杠铃卧推'}</span><p className="file-name">{report.metadata.name}</p></div><label className="side-select">观察侧面<select aria-label="观察侧面" value={report.side} onChange={changeSide}><option value="left">左侧</option><option value="right">右侧</option></select></label></div>
          <div className="stats-grid"><div><span>当前动作分段</span><strong>{report.countOverride??active.length}<small>次</small></strong><p>{report.countOverride!=null?'次数由你手动确认':'自动结果，请复核'}</p></div><div><span>可见关节帧占比</span><strong>{Math.round(report.coverage*100)}<small>%</small></strong><p>代表可见性，不是识别准确率</p></div><div><span>肘部活动幅度中位数</span><strong>{fmt(median(active.map(r=>r.range)))}<small>°</small></strong><p>实验性画面投影测量</p></div><div><span>每次动作时长中位数</span><strong>{fmt(median(active.map(r=>r.duration)))}<small>s</small></strong><p>按当前动作起止点统计</p></div></div>
          {report.status==='limited'&&<div className="message error">关键关节不够清晰。请先回看骨架和拍摄角度，当前结果不适合用来判断动作偏差。</div>}
          {!report.reps.length&&<div className="message">没有找到可复核的完整动作。可切换观察侧面，或在下方手动标注开始、底部和结束。</div>}
          <div className="analysis-grid"><section className="panel video-panel"><div className="section-line"><h3>动作回放</h3><span>肩 — 肘 — 腕</span></div><VideoReview report={report} file={file} time={time} onTime={setTime} seekTo={seek}/><AngleChart report={report} time={time} onSeek={jump}/></section><aside className="panel rep-panel"><div className="section-line"><h3>逐次检查</h3><span>{active.length} 段保留</span></div><div className="rep-list">{report.reps.map((r,i)=><div className={`rep-item ${selected===i?'selected':''}`} key={`${i}-${r.start}`}><input aria-label={`保留第 ${i+1} 次`} type="checkbox" checked={r.enabled} onChange={e=>editRep(i,{enabled:e.target.checked})}/><button onClick={()=>{setSelected(i);jump(r.bottom);}}><b>{String(i+1).padStart(2,'0')}</b><span>{fmt(r.range,'°')}<small>{r.source==='manual'?'手动分段':`${fmt(r.start)} – ${fmt(r.end)} s`}</small></span><em>{fmt(r.duration,'s')}</em></button></div>)}</div><div className="count-confirm"><label>实际次数<input aria-label="实际次数" type="number" min="0" max="200" placeholder={String(active.length)} value={report.countOverride??''} onChange={e=>{const n=e.target.value;setReport(r=>({...r,countOverride:n===''?null:Math.max(0,Math.min(200,Math.trunc(+n)))}));}}/></label><p>确认次数不会补造骨架或动作分段。</p></div><div className="metric-note">第 {selected+1} 次：下放 {fmt(report.reps[selected]?.eccentric,'s')} / 底部停顿 {fmt(report.reps[selected]?.pause,'s')} / 推起 {fmt(report.reps[selected]?.concentric,'s')}</div></aside></div>
          <details className="panel manual-panel"><summary>手动调整动作边界 <span>自动分段遗漏或位置不准时使用</span></summary><div className="boundary-grid">{[['start','开始'],['bottom','底部'],['end','结束']].map(([key,label])=><label key={key}>{label}（秒）<input aria-label={`动作${label}时间`} type="number" min="0" step="0.01" value={bounds[key]} onChange={e=>setBounds(b=>({...b,[key]:e.target.value}))}/><button className="text-button" onClick={()=>setBounds(b=>({...b,[key]:+time.toFixed(2)}))}>取当前画面</button></label>)}</div><div className="button-row"><button className="secondary" disabled={!report.reps.length} onClick={()=>applyBounds(false)}>更新第 {selected+1} 次</button><button className="secondary" onClick={()=>applyBounds(true)}>新增一段动作</button></div></details>
          <section className="panel reference-panel"><div className="section-line"><div><span className="eyebrow">02 / COMPARE</span><h3>与参考动作放在一起看</h3></div><span className="pill">差异观察，不做合格评分</span></div><p className="muted">采用相同侧拍角度、相同卧推类型的完整示范。参考动作需要你确认；合成示意不能作为标准动作。</p><div className="button-row"><label className={`secondary file-button ${progress?'disabled':''}`}>导入参考视频<input aria-label="选择参考视频" type="file" accept="video/*,.mp4,.mov" disabled={!!progress} onChange={e=>runFile(e,'reference')}/></label><button className="secondary" disabled={!report.reps[selected]?.valid} onClick={()=>{setReference(report);setReferenceFile(file);setReferenceIndex(selected);setNotice('已设为个人参考，请确认这次动作适合作为对比基准。');}}>用当前动作作为个人参考</button></div>
            {reference&&<><div className="reference-select"><span>{reference.metadata.name}</span><label>参考动作<select aria-label="选择参考动作次数" value={referenceIndex} onChange={e=>setReferenceIndex(+e.target.value)}>{reference.reps.map((r,i)=><option key={i} value={i}>第 {i+1} 次</option>)}</select></label></div><div className="compare-grid"><div><span className="mini-label">你的第 {selected+1} 次</span><p className="comparison-text">{comparison?.status==='compared'?`肘角差异中位数 ${fmt(comparison.medianAngleGap,'°')}`:comparison?.reason??'请选择有效动作'}</p>{comparison?.status==='compared'&&<><div className="comparison-stats"><div><span>底部肘角差</span><b>{fmt(comparison.bottomAngleDifference,'°')}</b></div><div><span>幅度差</span><b>{fmt(comparison.rangeDifference,'°')}</b></div><div><span>真实时长差</span><b>{fmt(comparison.durationDifference,'s')}</b></div></div><button className="text-button" onClick={()=>jump(comparison.worst.time)}>回看最大角度差异处 ↗</button></>}<p className="muted small">对齐用于比较动作形状；节奏仍按原始时间计算。不同机位和身体比例也会造成差异。</p></div><div><span className="mini-label">参考 · 第 {referenceIndex+1} 次</span><VideoReview compact report={reference} file={referenceFile} time={refTime} onTime={setRefTime} seekTo={refSeek}/></div></div></>}
          </section>
          <section className="panel"><div className="section-line"><h3>本组复盘</h3><span>优先回看这几处</span></div>{hints.length?hints.map((hint,i)=><button className="hint" key={i} onClick={()=>jump(hint.time)}><span>0{i+1}</span><div><strong>{hint.title}</strong><p>{hint.body}</p></div><b>↗</b></button>):<p className="muted">导入可用参考后，这里会列出最多三处明显差异。你现在也可以逐次检查幅度、节奏和关节跟踪情况。</p>}<p className="metric-note">本机单摄像头不能可靠判断肩胛收紧、左右受力、脊柱状态或伤病；当前不提供这些结论。</p><div className="save-row"><label><input type="checkbox" checked={keepVideo} onChange={e=>setKeepVideo(e.target.checked)} disabled={!file}/>保存时同时保留本机原视频</label><div className="button-row"><button className="secondary" onClick={()=>downloadReport(report)}>导出 JSON 报告</button><button className="primary" onClick={save}>保存本地复盘 ↗</button></div></div></section>
        </>}
      </section>
    </>}
    {page==='guide'&&<section className="guide"><span className="eyebrow">FILM WITH CLARITY</span><h1>拍得清楚，<br/>复盘才有依据。</h1><div className="guide-grid"><div>{instructions.map(([title,body],i)=><div className="panel guide-tip" key={title}><span className="step-label">0{i+1}</span><h3>{title}</h3><p>{body}</p></div>)}</div><div><div className="panel"><BenchDrawing/><p className="muted">镜头保持水平，固定在身体侧面。画面中应看到肩、肘、腕及整个推举范围。</p></div><div className="panel resource-card"><span className="step-label">公开教学参考</span><h3>先理解动作，再比较轨迹。</h3><a href="https://www.youtube.com/watch?v=4Y2ZdHCOXok" target="_blank" rel="noreferrer">Jeremy Ethier · 卧推五步教学 ↗</a><a href="https://www.youtube.com/watch?v=hWbUlkb5Ms4" target="_blank" rel="noreferrer">Jeff Nippard · 五步技术检查 ↗</a><a href="https://www.bilibili.com/video/BV15c411s7Tp/" target="_blank" rel="noreferrer">B站 · 卧推保姆级教学 ↗</a><p className="muted small">这些是学习链接，未被逐帧验证为自动对比模板，也未下载或内置第三方视频。</p></div></div></div><button className="primary" onClick={()=>setPage('work')}>准备好了，开始复盘 ↗</button></section>}
    {page==='history'&&<section className="history"><span className="eyebrow">YOUR TRAINING JOURNAL</span><h1>每次练习，都留一点进步。</h1><p className="muted">记录保存在当前浏览器。清除浏览器数据会丢失记录，重要复盘请导出备份。</p>{error&&<div className="message error" role="alert">{error}</div>}{!history.length?<div className="panel empty"><span>↗</span><h3>你的第一组复盘，还在前面。</h3><p>分析一组动作后，点击「保存本地复盘」即可在这里回看。</p><button className="primary" onClick={()=>setPage('work')}>开始复盘</button></div>:<div className="history-grid">{history.map(item=><article className="panel history-item" key={item.id}><span className="pill">{item.report.metadata.source==='synthetic'?'合成演示':'卧推'}</span><time>{new Date(item.savedAt).toLocaleDateString('zh-CN')}</time><h3>{item.report.metadata.name}</h3><strong>{item.report.countOverride??item.report.reps.filter(r=>r.enabled).length}<small> 次</small></strong><p>{item.file?'已保存本机原视频':'仅保存骨架和指标'} · {item.report.countOverride!=null?'次数手动确认':'自动计次待复核'}</p><div className="button-row"><button className="secondary" onClick={()=>resetReport(item.report,item.file)}>打开复盘</button><button className="text-button" onClick={async()=>{if(window.confirm('删除这条本地训练记录？')){try{await deleteSession(item.id);refresh();}catch(e){setError(e.message);}}}}>删除记录</button></div></article>)}</div>}</section>}
    <footer><span>FITNESS PRO <b>/</b> 看清每一次动作</span><span>本地处理 · 自动结果待复核 · v0.1</span></footer>
  </main>;
}
