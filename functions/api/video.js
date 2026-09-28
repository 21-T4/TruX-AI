let cachedAccessToken=null;
let cachedTokenExpiry=0;

function base64UrlEncode(data){
  const bytes=typeof data==="string"?new TextEncoder().encode(data):new Uint8Array(data);
  let binary="";
  for(let i=0;i<bytes.length;i+=0x8000) binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+0x8000,bytes.length)));
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
function pemToArrayBuffer(pem){
  const clean=String(pem||"").replace(/\\n/g,"\n").replace(/-----BEGIN PRIVATE KEY-----/g,"").replace(/-----END PRIVATE KEY-----/g,"").replace(/\s/g,"");
  const binary=atob(clean);
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  return bytes.buffer;
}
async function googleAccessToken(env){
  if(cachedAccessToken && Date.now()<cachedTokenExpiry-60000) return cachedAccessToken;
  const metadataUrls=[
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token"
  ];
  if(env.K_SERVICE||env.K_REVISION||env.K_CONFIGURATION){
    for(const url of metadataUrls){
      try{
        const r=await fetch(url,{headers:{"Metadata-Flavor":"Google"}});
        if(r.ok){
          const d=await r.json();
          if(d&&d.access_token){
            cachedAccessToken=d.access_token;
            cachedTokenExpiry=Date.now()+((Number(d.expires_in)||3600)*1000);
            return cachedAccessToken;
          }
        }
      }catch{}
    }
  }
  const clientEmail=String(env.GCP_CLIENT_EMAIL||env.GOOGLE_CLIENT_EMAIL||"").trim();
  const privateKey=String(env.GCP_PRIVATE_KEY||env.GOOGLE_PRIVATE_KEY||"");
  if(!clientEmail||!privateKey) throw new Error("Google credentials are unavailable for video playback.");
  const now=Math.floor(Date.now()/1000);
  const header=base64UrlEncode(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const claims=base64UrlEncode(JSON.stringify({iss:clientEmail,scope:"https://www.googleapis.com/auth/devstorage.read_only",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600}));
  const unsigned=header+"."+claims;
  const key=await crypto.subtle.importKey("pkcs8",await pemToArrayBuffer(privateKey),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
  const signature=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(unsigned));
  const response=await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:unsigned+"."+base64UrlEncode(signature)}).toString()
  });
  if(!response.ok) throw new Error("Google authentication failed for video playback.");
  const data=await response.json();
  cachedAccessToken=data.access_token;
  cachedTokenExpiry=Date.now()+((Number(data.expires_in)||3600)*1000);
  return cachedAccessToken;
}
function parseGsUri(uri){
  const value=String(uri||"");
  if(!value.startsWith("gs://")) return null;
  const rest=value.slice(5);
  const slash=rest.indexOf("/");
  if(slash<=0) return null;
  return {bucket:rest.slice(0,slash),object:rest.slice(slash+1)};
}

export async function onRequestGet({request,env}){
  try{
    const uri=new URL(request.url).searchParams.get("uri")||"";
    const parsed=parseGsUri(uri);
    const configured=String(env.TRUX_VIDEO_OUTPUT_GCS_URI||env.VIDEO_OUTPUT_GCS_URI||"").trim().replace(/\/+$/,"");
    if(!parsed||!configured.startsWith("gs://")||!uri.startsWith(configured+"/")) return new Response("Not found.",{status:404});

    const token=await googleAccessToken(env);
    const gcsUrl="https://storage.googleapis.com/storage/v1/b/"+encodeURIComponent(parsed.bucket)+"/o/"+encodeURIComponent(parsed.object)+"?alt=media";
    const r=await fetch(gcsUrl,{headers:{Authorization:"Bearer "+token}});
    if(!r.ok){
      const errorText=await r.text().catch(()=> "");
      return new Response(errorText||"Video could not be loaded.",{status:r.status});
    }
    const headers=new Headers();
    headers.set("Content-Type",r.headers.get("content-type")||"video/mp4");
    headers.set("Cache-Control","private, max-age=3600");
    const len=r.headers.get("content-length");
    if(len) headers.set("Content-Length",len);
    return new Response(r.body,{status:200,headers});
  }catch(error){
    return new Response((error&&error.message)||"Video playback failed.",{status:500});
  }
}
