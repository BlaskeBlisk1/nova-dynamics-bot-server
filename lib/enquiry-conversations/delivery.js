'use strict';
const {createHash,createHmac,timingSafeEqual,randomBytes,createCipheriv,createDecipheriv}=require('node:crypto');
const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const EMAIL=/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
function email(value){return typeof value==='string'&&value.length<=254&&EMAIL.test(value)?value.toLowerCase():null;}
function key(raw){
  if(typeof raw!=='string')return null;
  try{const result=Buffer.from(raw,'base64');return result.length===32&&result.toString('base64')===raw?result:null;}catch{return null;}
}
function encrypt(payload,secret,context){
  if(!secret)throw new Error('encryption_unavailable');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,iv);cipher.setAAD(Buffer.from(context));
  const body=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),body].map(x=>x.toString('base64')).join('.');
}
function decrypt(raw,secret,context){
  if(!secret||typeof raw!=='string')throw new Error('encryption_unavailable');
  const parts=raw.split('.').map(x=>Buffer.from(x,'base64'));
  if(parts.length!==3||parts[0].length!==12||parts[1].length!==16)throw new Error('invalid_payload');
  const decipher=createDecipheriv('aes-256-gcm',secret,parts[0]);decipher.setAAD(Buffer.from(context));decipher.setAuthTag(parts[1]);
  return JSON.parse(Buffer.concat([decipher.update(parts[2]),decipher.final()]).toString('utf8'));
}
function senderConfig(env,cfg){
  try{
    const raw=JSON.parse(env.JEMLIO_CONVERSATION_SEND_CONFIG||'{}');
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>100)return {};
    const result={};
    for(const [client,value]of Object.entries(raw)){
      if(!cfg?.tenants?.[client]||!value||Object.keys(value).some(k=>!['enabled','from','replyTo'].includes(k))||value.enabled!==true||!email(value.from)||value.replyTo!==undefined&&!email(value.replyTo))continue;
      result[client]={from:email(value.from),...(value.replyTo?{reply_to:email(value.replyTo)}:{})};
    }
    return result;
  }catch{return {};}
}
function webhookKey(secret){
  if(typeof secret!=='string'||!secret.startsWith('whsec_'))return null;
  const raw=secret.slice(6),bytes=Buffer.from(raw,'base64');
  return /^[A-Za-z0-9+/]+={0,2}$/.test(raw)&&bytes.length>=16&&bytes.toString('base64').replace(/=+$/,'')===raw.replace(/=+$/,'')?bytes:null;
}
function verifyWebhook(body,headers,secret,now=Date.now){
  const bytes=webhookKey(secret);if(!Buffer.isBuffer(body)||!bytes)return false;
  const id=headers['svix-id'],timestamp=headers['svix-timestamp'],signatures=headers['svix-signature'];
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(id)||typeof timestamp!=='string'||!/^\d{10,12}$/.test(timestamp)||
    Math.abs(now()-Number(timestamp)*1000)>300000||typeof signatures!=='string'||signatures.length>2000)return false;
  try{
    const expected=createHmac('sha256',bytes).update(`${id}.${timestamp}.`).update(body).digest();
    return signatures.split(/\s+/).some(part=>{const [version,value,...rest]=part.split(',');if(version!=='v1'||!value||rest.length)return false;const actual=Buffer.from(value,'base64');return actual.length===expected.length&&actual.toString('base64')===value&&timingSafeEqual(expected,actual);});
  }catch{return false;}
}
module.exports={hash,email,key,encrypt,decrypt,senderConfig,verifyWebhook,webhookKey};
