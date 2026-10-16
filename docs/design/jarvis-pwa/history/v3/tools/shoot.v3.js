// OVD-799 v3: render direct, parallel, decide, result at 430 wide, full page, plus a side by side PNG. Runs the v1 checks.
// Usage: python3 tools/build.v3.py && node tools/shoot.v3.js
const path=require('path'),fs=require('fs');
let pw;try{pw=require('playwright-core')}catch{pw=require('/workspace/designs/_tools/node_modules/playwright-core')}
const root=path.resolve(__dirname,'..'),out=path.join(root,'screenshots','v3');fs.mkdirSync(out,{recursive:true});
const url='file://'+path.join(root,'mock','v3.html');
const STATES=['direct','parallel','decide','result','more'],W=430,DASH=/[\-\u2010-\u2015\u2212\u2026]/;
(async()=>{
 const b=await pw.chromium.launch({executablePath:process.env.CHROME||'/usr/bin/google-chrome',args:['--no-sandbox']});
 const report=[];
 for(const state of STATES){
  const ctx=await b.newContext({viewport:{width:W,height:932},deviceScaleFactor:2,isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
  await p.goto(`${url}?state=${state}&shot=1`);await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(200);
  const file=`${state}-${W}.png`;await p.screenshot({path:path.join(out,file),fullPage:state!=='more'});
  const r=await p.evaluate(dash=>{const D=new RegExp(dash);const vis=el=>{const s=getComputedStyle(el),rc=el.getBoundingClientRect();return s.visibility!=='hidden'&&s.display!=='none'&&rc.width>0&&rc.height>0};
   const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);const dashes=[],small=[];let n;
   while((n=w.nextNode())){const t=n.textContent.trim(),el=n.parentElement;if(!t||!vis(el)||el.closest('script,style,svg'))continue;if(D.test(t))dashes.push(t);if(parseFloat(getComputedStyle(el).fontSize)<11)small.push(t)}
   document.querySelectorAll('[aria-label]').forEach(e=>{if(D.test(e.getAttribute('aria-label')))dashes.push('aria: '+e.getAttribute('aria-label'))});
   const st=[...document.querySelectorAll('#root button,#root a,#root textarea')].filter(vis).map(e=>{const rc=e.getBoundingClientRect();return{t:(e.getAttribute('aria-label')||e.textContent).trim().slice(0,30),w:Math.round(rc.width),h:Math.round(rc.height)}}).filter(x=>x.w<44||x.h<44);
   const accents=[...document.querySelectorAll('#root *')].filter(e=>{if(!vis(e))return false;const c=getComputedStyle(e);return [c.color,c.backgroundColor,c.borderTopColor].includes('rgb(255, 122, 26)')}).length;
   return{overflowX:document.documentElement.scrollWidth-innerWidth,dashes,small,smallTargets:st,accentElements:accents,sample:/sample/i.test(document.body.innerText)}},DASH.source);
  const ok=r.overflowX<=0&&!r.dashes.length&&!r.small.length&&!r.smallTargets.length&&r.accentElements<=1&&r.sample&&!errs.length;
  report.push({file,state,width:W,ok,...r,pageErrors:errs});console.log(ok?'PASS':'FAIL',file,ok?'':JSON.stringify(r));await ctx.close();
 }
 // side by side of the three main states
 const imgs=['direct','parallel','decide','result'].map(s=>'data:image/png;base64,'+fs.readFileSync(path.join(out,`${s}-${W}.png`)).toString('base64'));
 const ctx=await b.newContext({viewport:{width:4*W+5*24,height:900},deviceScaleFactor:2});const p=await ctx.newPage();
 await p.setContent(`<body style="margin:0;background:#050506;display:flex;gap:24px;padding:24px;align-items:flex-start">${imgs.map(i=>`<img src="${i}" style="width:${W}px;border:1px solid #2A2A2F">`).join('')}</body>`);
 await p.waitForTimeout(300);await p.screenshot({path:path.join(out,'combined-direct-parallel-decide-result.png'),fullPage:true});
 await b.close();fs.writeFileSync(path.join(out,'checks-report.json'),JSON.stringify(report,null,2));
 const f=report.filter(x=>!x.ok).length;console.log(`${report.length-f}/${report.length} pass`);process.exit(f?1:0);
})();
