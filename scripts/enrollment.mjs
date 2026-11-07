/** Client-local enrollment. Never export a bearer secret to tools, logs or messages. */
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdir,open,readFile,rename,lstat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {defaultConfigPath,PinkchatClientError,validateBaseUrl} from './client.mjs';
import {CLIENT_VERSION,rememberServerVersions,updateNotice,parseVersion,packageInfo} from './version.mjs';
const fail=(code)=>{throw new PinkchatClientError(code,0,code);};
/** Kinds the server accepts; one person may connect several of these agents. */
export const CLIENT_KINDS=['codex','grok','claude-code','claude','chatgpt','muse','openclaw','hermes','gemini','cursor','other'];
const capabilities={ownerKnowledge:'unknown',ownBots:'unknown',allBotsEnumeration:false,calendarRead:'unknown',approximateLocation:'unknown',imageInput:'unknown',nativeGroupTransport:false,evidence:[]};
const pathFor=p=>p?.startsWith('~/')?resolve(process.env.HOME,p.slice(2)):resolve(p||defaultConfigPath());
async function readPrivate(path){
 const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0)fail('config_permissions');
 try{return JSON.parse(await readFile(path,'utf8'));}catch{fail('config_invalid_json');}
}
async function request(config,path,method='GET',body,proof=false){
 const headers={accept:'application/json','x-pinkchat-client-version':CLIENT_VERSION};
 if(body)headers['content-type']='application/json';
 if(proof){headers.authorization=`Bearer ${config.token}`;headers['x-pinkchat-installation']=config.installationId;}
 let response;
 try{response=await fetch(`${validateBaseUrl(config.baseUrl)}/client/v1/${path}`,{method,headers,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(15000)});}catch{fail('enrollment_network_error');}
 rememberServerVersions(response.headers);
 if(response.status===426)fail('client_upgrade_required');
 if(!response.ok){
  // Server error codes are public, fixed identifiers (for example email_code_invalid); nothing else is echoed.
  let code='';try{const e=(await response.json()).error;if(typeof e==='string'&&/^[a-z0-9_]{1,64}$/.test(e))code=`:${e}`;}catch{}
  fail(`enrollment_http_${response.status}${code}`);
 }
 return response.json();
}
function validateMetadata(label,reported){
 if(typeof label!=='string'||!label.trim()||label.trim().length>80)fail('invalid_enrollment_label');
 const names=['ownerKnowledge','ownBots','calendarRead','approximateLocation','imageInput'];
 const allowed=[...names,'allBotsEnumeration','nativeGroupTransport','evidence'];
 if(!reported||typeof reported!=='object'||Object.keys(reported).some(k=>!allowed.includes(k))||reported.nativeGroupTransport!==false||reported.allBotsEnumeration!==undefined&&reported.allBotsEnumeration!==false)fail('invalid_capabilities');
 for(const name of names)if(!['available','unavailable','unknown',...(name==='ownBots'?['request_only']:[])].includes(reported[name]))fail('invalid_capabilities');
 if(!Array.isArray(reported.evidence)||reported.evidence.length>12)fail('invalid_capabilities');
 for(const e of reported.evidence)if(!e||Object.keys(e).some(k=>!['capability','status','source'].includes(k))||!names.includes(e.capability)||!['authorized','read_succeeded','unavailable','unverified'].includes(e.status)||typeof e.source!=='string'||!e.source.trim()||e.source.trim().length>120)fail('invalid_capabilities');
}
// Which link the owner came from (`?ref=` on the install page): a short label for counting signups.
// An unusable value is dropped rather than failing the install.
const cleanSource=v=>{if(typeof v!=='string')return undefined;const s=v.trim().toLowerCase();return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(s)?s:undefined;};
export async function onboard({baseUrl,clientKind,label,capabilities:reported=capabilities,inviteCode,linkCode,source},configPath){
 const path=pathFor(configPath);let config;
 try{config=await readPrivate(path);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!config){
  validateMetadata(label,reported);
  if(!CLIENT_KINDS.includes(clientKind)||typeof label!=='string'||!label.trim())fail('enrollment_metadata_required');
  config={baseUrl:validateBaseUrl(baseUrl),token:randomBytes(32).toString('base64url'),installationId:randomUUID(),enrollmentId:randomUUID(),clientKind,metadata:{label,capabilities:reported,...(cleanSource(source)?{source:cleanSource(source)}:{})}};
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const file=await open(path,'wx',0o600);try{await file.writeFile(JSON.stringify(config)+'\n');}finally{await file.close();}
 }else if((baseUrl&&validateBaseUrl(baseUrl)!==config.baseUrl)||(clientKind&&clientKind!==config.clientKind))fail('enrollment_config_identity_changed');
 if(!config.enrollmentId)fail('legacy_config_requires_separate_personal_config');
 if(inviteCode&&linkCode)fail('one_code_at_most');
 // Codes are redeemed by the server once and never written to the private config.
 const code=v=>{if(v===undefined)return undefined;if(typeof v!=='string'||!/^pk-[a-z0-9]{12}$/.test(v.trim().toLowerCase()))fail('invite_code_format_invalid');return v.trim().toLowerCase();};
 const body={enrollmentId:config.enrollmentId,installationId:config.installationId,tokenHash:createHash('sha256').update(config.token).digest('hex'),clientKind:config.clientKind,metadata:config.metadata,...(inviteCode!==undefined?{inviteCode:code(inviteCode)}:{}),...(linkCode!==undefined?{linkCode:code(linkCode)}:{})};
 const submitted=await request(config,'enrollments','POST',body);
 const status=await enrollmentStatus(path);
 return status.status==='pending' ? {...status,verificationUrl:submitted.verificationUrl,userCode:submitted.userCode,expiresAt:submitted.expiresAt,pollingInterval:submitted.pollingInterval} : status;
}
export async function enrollmentStatus(configPath){
 const path=pathFor(configPath),config=await readPrivate(path);
 if(!config.enrollmentId)fail('personal_enrollment_required');
 const status=await request(config,`enrollments/${config.enrollmentId}`,'GET',undefined,true);
 if(status.installationId!==config.installationId||status.enrollmentId!==config.enrollmentId)fail('enrollment_response_mismatch');
 if(status.status==='approved'){
  if(typeof status.accountId!=='string'||!/^person-[a-f0-9-]{36}$/.test(status.accountId))fail('enrollment_binding_invalid');
  if(config.accountId&&config.accountId!==status.accountId)fail('enrollment_rebind_forbidden');
  const temporary=`${path}.${randomUUID()}.tmp`,f=await open(temporary,'wx',0o600);
  try{await f.writeFile(JSON.stringify({...config,accountId:status.accountId})+'\n');}finally{await f.close();}
  await rename(temporary,path);
 }
 return status;
}
export const langField=lang=>typeof lang==='string'&&lang.trim()?{lang:lang.trim().slice(0,64)}:{};
/**
 * Email registration: the server mails a 6-digit code; the same verified address always means the same person.
 * `lang` (BCP 47, e.g. zh-CN, ja, en) is the owner's language, so the email is written in it alone.
 */
export async function emailStart(email,configPath,lang){
 const config=await readPrivate(pathFor(configPath));
 if(typeof email!=='string'||!email.includes('@'))fail('email_required');
 if(config.accountId)fail('already_approved_use_profile_email');
 return request(config,`enrollments/${config.enrollmentId}/email`,'POST',{email:email.trim(),...langField(lang)},true);
}
export async function emailVerify(code,configPath){
 const path=pathFor(configPath),config=await readPrivate(path);
 if(typeof code!=='string'||!/^\d{6}$/.test(code.trim()))fail('email_code_format_invalid');
 if(config.accountId)fail('already_approved_use_profile_email');
 const result=await request(config,`enrollments/${config.enrollmentId}/email/verify`,'POST',{code:code.trim()},true);
 const status=await enrollmentStatus(path);
 return {...status,person:result.person};
}
/** Ask the public release manifest whether this package is current. Needs no credential. */
export async function updateCheck(configPath,{baseUrl,package:requested}={}){
 let origin=baseUrl;
 if(!origin){
  try{origin=(await readPrivate(pathFor(configPath))).baseUrl;}
  catch(error){throw error instanceof PinkchatClientError?error:new PinkchatClientError('update_check_base_url_required',0,'update_check_base_url_required');}
 }
 origin=validateBaseUrl(origin);
 const kind=requested||(await packageInfo()).package;
 let manifest;
 try{const response=await fetch(`${origin}/releases/latest.json`,{headers:{accept:'application/json','x-pinkchat-client-version':CLIENT_VERSION},redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)fail(`update_check_http_${response.status}`);manifest=await response.json();}
 catch(error){if(error instanceof PinkchatClientError)throw error;fail('update_check_network_error');}
 const pkg=kind&&manifest?.packages?.[kind];
 const latest=parseVersion(pkg?.version)?pkg.version:manifest?.latestVersion;
 const versions={latest:parseVersion(latest)?latest:undefined,minimum:parseVersion(manifest?.minimumVersion)?manifest.minimumVersion:undefined,install:typeof manifest?.install==='string'?manifest.install:undefined};
 const notice=updateNotice(versions);
 return {status:notice?.status??'current',origin,current:CLIENT_VERSION,latest:versions.latest??CLIENT_VERSION,...(versions.minimum?{minimum:versions.minimum}:{}),...(kind?{package:kind}:{}),...(pkg?{download:{file:pkg.file,url:pkg.url,sha256:pkg.sha256,...(pkg.signature&&typeof pkg.signature==='object'?{signature:{keyId:String(pkg.signature.keyId),value:String(pkg.signature.value)}}:{})}}:{}),...(versions.install?{install:versions.install}:{}),...(notice?{next:notice.next}:{})};
}
export const unknownCapabilities=capabilities;
