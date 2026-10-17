// OVD-799 v4: every state at 430 (full page) and 375 (checks, saved under 375/), plus a combined PNG. Usage: python3 tools/build.v4.py && node tools/shoot.v4.js
const path=require('path'),fs=require('fs');
let pw;try{pw=require('playwright-core')}catch{pw=require('/workspace/designs/_tools/node_modules/playwright-core')}
const root=path.resolve(__dirname,'..'),out=path.join(root,'screenshots','v4');fs.mkdirSync(path.join(out,'375'),{recursive:true});
const url='file://'+path.join(root,'mock','v4.html');
const STATES=["empty","direct","parallel","decide","evidence","result","commit","committed","more","paused","failed","checkfail","offline"];
const OVERLAY=new Set(["evidence","commit","more"]);const DASH=/[\-\u2010-\u2015\u2212\u2026]/;
(async()=>{
 const b=await pw.chromium.launch({executablePath:process.env.CHROME||'/usr/bin/google-chrome',args:['--no-sandbox']});
 const report=[];
 for(const W of [430,375]) for(const state of STATES){
  const ctx=await b.newContext({viewport:{width:W,height:W===430?932:812},deviceScaleFactor:2,isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
  await p.goto(`${url}?state=${state}&shot=1`);await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(150);
  const file=W===430?`${state}-430.png`:`375/${state}-375.png`;await p.screenshot({path:path.join(out,file),fullPage:!OVERLAY.has(state)});
  const r=await p.evaluate(dash=>{const D=new RegExp(dash);const vis=el=>{const s=getComputedStyle(el),rc=el.getBoundingClientRect();return s.visibility!=='hidden'&&s.display!=='none'&&rc.width>0&&rc.height>0};
   const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);const dashes=[],small=[];let n;
   while((n=w.nextNode())){const t=n.textContent.trim(),el=n.parentElement;if(!t||!vis(el)||el.closest('script,style,svg'))continue;if(D.test(t))dashes.push(t);if(parseFloat(getComputedStyle(el).fontSize)<11)small.push(t)}
   document.querySelectorAll('[aria-label]').forEach(e=>{if(D.test(e.getAttribute('aria-label')))dashes.push('aria: '+e.getAttribute('aria-label'))});
   const st=[...document.querySelectorAll('#root button,#root a,#root textarea')].filter(vis).map(e=>{const rc=e.getBoundingClientRect();return{t:(e.getAttribute('aria-label')||e.textContent).trim().slice(0,30),w:Math.round(rc.width),h:Math.round(rc.height)}}).filter(x=>x.w<44||x.h<44);
   const accents=[...document.querySelectorAll('#root *')].filter(e=>{if(!vis(e))return false;const c=getComputedStyle(e);return [c.color,c.backgroundColor,c.borderTopColor].includes('rgb(255, 122, 26)')}).length;
   const lum=h=>{const c=[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).map(v=>v<=.03928?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]};const cr=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
   const cs=getComputedStyle(document.documentElement);const v=n=>cs.getPropertyValue(n).trim();
   const contrast={onBg:+cr(v('--control-border'),v('--bg')).toFixed(2),onSurface:+cr(v('--control-border'),v('--surface')).toFixed(2)};
   const clipped=[...document.querySelectorAll('#root .state')].filter(e=>vis(e)&&e.scrollWidth>e.clientWidth+1).map(e=>e.textContent.trim());
   return{contrast,clipped,overflowX:document.documentElement.scrollWidth-innerWidth,dashes,small,smallTargets:st,accentElements:accents,sample:/sample/i.test(document.body.innerText)}},DASH.source);
  r.rendered=await p.evaluate(()=>document.getElementById('root').children.length>0);const ok=r.rendered&&r.contrast.onBg>=3&&r.contrast.onSurface>=3&&!r.clipped.length&&r.overflowX<=0&&!r.dashes.length&&!r.small.length&&!r.smallTargets.length&&r.accentElements<=1&&r.sample&&!errs.length;
  report.push({file,state,width:W,ok,...r,pageErrors:errs});console.log(ok?'PASS':'FAIL',file,ok?'':JSON.stringify(r));await ctx.close();
 }
 const main=['direct','parallel','decide','result','committed'],W=430;
 const imgs=main.map(s=>'data:image/png;base64,'+fs.readFileSync(path.join(out,`${s}-430.png`)).toString('base64'));
 const ctx=await b.newContext({viewport:{width:main.length*W+(main.length+1)*24,height:900},deviceScaleFactor:2});const p=await ctx.newPage();
 await p.setContent(`<body style="margin:0;background:#050506;display:flex;gap:24px;padding:24px;align-items:flex-start">${imgs.map(i=>`<img src="${i}" style="width:${W}px;border:1px solid #2A2A2F">`).join('')}</body>`);
 await p.waitForTimeout(300);await p.screenshot({path:path.join(out,'combined-direct-parallel-decide-result-committed.png'),fullPage:true});
 await b.close();fs.writeFileSync(path.join(out,'checks-report.json'),JSON.stringify(report,null,2));
 const f=report.filter(x=>!x.ok).length;console.log(`${report.length-f}/${report.length} pass`);process.exit(f?1:0);
})();
