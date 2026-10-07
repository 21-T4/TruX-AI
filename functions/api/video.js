import { Storage } from '@google-cloud/storage';
import { Readable } from 'node:stream';

const storage = new Storage();

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

    const file=storage.bucket(parsed.bucket).file(parsed.object);
    const [metadata]=await file.getMetadata();
    const headers=new Headers();
    headers.set("Content-Type",metadata.contentType||"video/mp4");
    headers.set("Cache-Control","private, max-age=3600");
    if(metadata.size!=null) headers.set("Content-Length",String(metadata.size));
    return new Response(Readable.toWeb(file.createReadStream()),{status:200,headers});
  }catch(error){
    return new Response((error&&error.message)||"Video playback failed.",{status:500});
  }
}
