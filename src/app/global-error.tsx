'use client';
/** Last-resort fallback when the root layout itself fails; it replaces <html>, so it carries its own minimal styling. */
export default function GlobalError({error}:{error:Error&{digest?:string}}){
  return <html lang="en"><body style={{background:'#06080b',color:'#e6e8eb',fontFamily:'system-ui,sans-serif',padding:'96px 16px',maxWidth:560,margin:'0 auto'}}>
    <h1 style={{fontSize:24,fontWeight:700}}>Kalshi Advisor could not load</h1>
    <p style={{marginTop:12,fontSize:14,color:'#9aa3ad'}}>{error.message||'Unexpected error.'} If the app was just rebuilt or restarted, reloading usually fixes this.</p>
    <button type="button" onClick={()=>location.reload()} style={{marginTop:24,minHeight:40,padding:'0 16px',borderRadius:12,border:'1px solid #2a3139',background:'#11161c',color:'inherit',cursor:'pointer'}}>Reload</button>
  </body></html>;
}
