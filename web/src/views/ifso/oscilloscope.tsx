"use client";
import {useEffect,useRef} from 'react';
import './oscilloscope.css';

const beats=[
 {title:'IF SOMETHING\nHAPPENS',sub:'A CONDITION IS SET',mode:'intent'},
 {title:'USDG IN\nESCROW',sub:'FUNDS HELD BY THE CONTRACT',mode:'escrow'},
 {title:'ONE PRIVATE\nCLAIM LINK',sub:'A PASSKEY BINDS THE RECIPIENT',mode:'claim'},
 {title:'A MOMENT\nIS MEASURED',sub:'TIME  /  PRICE  /  APPROVAL  /  RESULT',mode:'measure'},
 {title:'A RESULT\nIS CHECKED',sub:'SOURCES  →  BOND  →  DISPUTE WINDOW',mode:'resolve'},
 {title:'RELEASE\nOR RETURN',sub:'EVERY PAYMENT HAS AN EXPIRY',mode:'return'},
 {title:'IFSO',sub:'MONEY THAT MOVES WHEN SOMETHING HAPPENS',mode:'mark'},
] as const;
const duration=4.2,total=beats.length*duration;
const clamp=(v:number)=>Math.max(0,Math.min(1,v));
function scope(ctx:CanvasRenderingContext2D,w:number,h:number,t:number,logo:HTMLImageElement){
 const s=Math.min(w/1200,h/680);ctx.clearRect(0,0,w,h);ctx.save();ctx.translate((w-1200*s)/2,(h-680*s)/2);ctx.scale(s,s);
 ctx.fillStyle='#0e0b0a';ctx.fillRect(0,0,1200,680);
 ctx.strokeStyle='rgba(204,83,64,.12)';ctx.lineWidth=1;
 for(let x=70;x<=1130;x+=70){ctx.beginPath();ctx.moveTo(x,85);ctx.lineTo(x,600);ctx.stroke()}
 for(let y=100;y<=600;y+=60){ctx.beginPath();ctx.moveTo(70,y);ctx.lineTo(1130,y);ctx.stroke()}
 const index=Math.floor(t/duration)%beats.length, phase=(t%duration)/duration, beat=beats[index];
 const intro=clamp(phase*4), outro=clamp((1-phase)*5), alpha=Math.min(intro,outro);
 const glow=(width:number,opacity:number)=>{ctx.strokeStyle=`rgba(255,141,115,${opacity})`;ctx.lineWidth=width;ctx.shadowColor='#ed5540';ctx.shadowBlur=16};
 const trace=(draw:(u:number)=>[number,number],count:number,progress=1)=>{ctx.beginPath();const end=Math.floor(count*clamp(progress));for(let i=0;i<=end;i++){const [x,y]=draw(i/count);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.stroke()};
 ctx.fillStyle='#ba6556';ctx.font='11px monospace';ctx.letterSpacing='2px';ctx.fillText('IFSO // SIGNAL',44,43);ctx.textAlign='right';ctx.fillText(beat.mode.toUpperCase(),1150,43);ctx.textAlign='left';
 // A carrier line builds into a changing bank of noisy, moving waveforms.
 for(let layer=0;layer<7;layer++){
  const intensity=index===0?.1:index===6?.18:.5+Math.sin(phase*Math.PI)*.5;
  glow(layer===0?1.2:.55,.55-layer*.055);
  trace(u=>{const x=70+u*1060;const pulse=Math.pow(Math.max(0,1-Math.abs(u-((phase*1.6)%1))/.17),2);const wave=Math.sin(u*40-t*3.4+layer*.55)*11+Math.sin(u*94+t*4+layer)*4+Math.sin(u*178-t*2+layer)*2;return [x,555+layer*4+wave*intensity+Math.sin(u*35-t*7)*pulse*28]},260);
 }
 ctx.save();ctx.globalCompositeOperation='screen';ctx.globalAlpha=alpha;
 if(index===1){
  for(let n=0;n<8;n++){const r=50+n*24+Math.sin(t*2+n)*5;glow(.8,.7-n*.06);trace(u=>[600+Math.cos(u*Math.PI*2)*r,290+Math.sin(u*Math.PI*2)*r*.78],180,clamp(phase*2.8));}
 }else if(index===2){
  glow(1.2,.85);trace(u=>[600+Math.cos(u*Math.PI*2)*165,295+Math.sin(u*Math.PI*2)*165],180,clamp(phase*2.8));
  for(let n=0;n<12;n++){const a=t*1.5-n*.06;glow(1,.7-n*.05);ctx.beginPath();ctx.moveTo(600,295);ctx.lineTo(600+Math.cos(a)*160,295+Math.sin(a)*160);ctx.stroke()}
 }else if(index===3){
  for(let n=0;n<(w<800?8:14);n++){glow(.8,.55-n*.025);trace(u=>{const a=u*Math.PI*2;return [600+Math.sin(a*(3+n*.04)+t*.7)*250*Math.cos(a*.7),290+Math.sin(a*(2+n*.05)-t*.45)*150*Math.sin(a*.8)]},220,clamp(phase*3));}
 }else if(index===4){
  for(let n=0;n<10;n++){glow(.8,.7-n*.055);trace(u=>[80+u*1040,450+Math.sin(u*12-t*3+n*.12)*42+n*2],200,clamp(phase*2.5))}
  glow(1.7,.9);trace(u=>{const x=90+u*1020;const step=Math.floor(u*8+t*1.4)%2;return [x,500-step*60]},240,clamp(phase*2.5));
 }else if(index===5){
  const r=170;glow(1.1,.8);trace(u=>[600+Math.cos(u*Math.PI*2)*r,300+Math.sin(u*Math.PI*2)*r],180,clamp(phase*3));
  for(let n=0;n<18;n++){const a=t*2.2-n*.035;glow(.8,.75-n*.037);ctx.beginPath();ctx.moveTo(600,300);ctx.lineTo(600+Math.cos(a)*r,300+Math.sin(a)*r);ctx.stroke()}
 }else if(index===6){
  for(let n=0;n<4;n++){glow(1.2,.65-n*.12);trace(u=>[600+Math.cos(u*Math.PI*2)*240,260+Math.sin(u*Math.PI*2)*(125+n*4)],180,clamp(phase*2))}
  if(logo.complete&&logo.naturalWidth){ctx.globalAlpha=alpha;ctx.drawImage(logo,565,115,70,70)}
 }
 ctx.restore();
 // The title is written onto the screen from left to right, then released in one quick sweep.
 ctx.save();ctx.globalAlpha=alpha;ctx.textAlign='center';ctx.font='700 72px sans-serif';ctx.lineWidth=1.8;ctx.strokeStyle='#ffb69e';ctx.fillStyle='rgba(255,110,85,.14)';ctx.shadowColor='#ff7156';ctx.shadowBlur=22;
 const reveal=clamp(phase*4.2);ctx.beginPath();ctx.rect(120,130,960*reveal,240);ctx.clip();
 const lines=beat.title.split('\n');for(let i=0;i<lines.length;i++){const y=258+(i-(lines.length-1)/2)*84;ctx.fillText(lines[i],600,y);ctx.strokeText(lines[i],600,y)}
 ctx.restore();ctx.globalAlpha=alpha;ctx.shadowBlur=0;ctx.textAlign='center';ctx.fillStyle='#f4b09a';ctx.font='12px monospace';ctx.fillText(beat.sub,600,397);
 ctx.globalAlpha=1;ctx.textAlign='left';ctx.fillStyle='#a15c4e';ctx.font='10px monospace';ctx.fillText('CH 01 / USDG  ·  ROBINHOOD CHAIN',70,630);ctx.textAlign='right';ctx.fillText(`IF / SO  ${(t%total).toFixed(1).padStart(4,'0')} SEC`,1130,630);ctx.restore();
}
export function Oscilloscope(){const canvas=useRef<HTMLCanvasElement>(null);useEffect(()=>{const el=canvas.current;if(!el)return;const ctx=el.getContext('2d');if(!ctx)return;const logo=new window.Image();logo.src='/ifso-seal-transparent.png';let frame=0,last=0,elapsed=0,visible=false;const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;if(reduced)elapsed=duration*.5;const draw=(now:number)=>{if(!visible)return;if(last&&!reduced)elapsed+=Math.min((now-last)/1000,.05);last=now;const rect=el.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,1.5);const w=Math.round(rect.width*ratio),h=Math.round(rect.height*ratio);if(el.width!==w||el.height!==h){el.width=w;el.height=h}scope(ctx,w,h,elapsed,logo);if(!reduced)frame=requestAnimationFrame(draw)};const observer=new IntersectionObserver(([e])=>{visible=e.isIntersecting;if(visible){last=0;frame=requestAnimationFrame(draw)}else{cancelAnimationFrame(frame);last=0}},{rootMargin:'10%'});observer.observe(el);return()=>{observer.disconnect();cancelAnimationFrame(frame)}},[]);return <section id="scope" className="scope-section" aria-labelledby="scope-title"><div className="scope-heading"><div><p>IFSO / THE SIGNAL</p><h2 id="scope-title">A condition becomes <i>a moment.</i></h2></div><span>THE IFSO PAYMENT PATH</span></div><canvas ref={canvas} role="img" aria-label="Oscilloscope animation explains the IFSO payment journey: condition, USDG escrow, claim link, evaluation, result and refund path."/><p className="scope-caption">IFSO brings the condition, the payment and the path back into one clear flow.</p></section>}
