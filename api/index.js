'use strict';
// Vercel invokes a request handler; it must never call server.listen().
const {createApp}=require('../backend/server.cjs');
let application;
module.exports=async (req,res)=>{
  try {
    const url=new URL(req.url,'https://localhost');
    // Preserve the original API path across Vercel rewrites.
    const route=url.searchParams.get('route');
    if(route!==null) req.url='/api/'+route;
    application ||= createApp({serverless:true});
    const app=await application;
    return await app.handler(req,res);
  }catch(error){
    application=undefined;
    console.error('Backend initialization failed:',error.message);
    // Only known configuration messages are public; credentials and runtime details stay private.
    const safeCodes=['MISSING_REDIS_CONFIG','INVALID_REDIS_URL','INVALID_AUTH_SECRET','INVALID_APP_ORIGIN'];
    const known=safeCodes.includes(error.code);
    const message=known?error.message:'Backend failed to initialize. Check the Vercel Function logs for this deployment.';
    if(!res.headersSent){res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:message,code:known?error.code:'BACKEND_STARTUP_FAILED',...(known&&error.missing?{missing:error.missing}:{})}));}
  }
};
