"""Refresh bundled catalogue icons; requires network only at build time."""
import concurrent.futures, json, subprocess, tempfile
from pathlib import Path
from urllib.parse import urlparse, quote
root=Path(__file__).resolve().parent.parent
apps=json.loads((root/'web-apps.json').read_text())
manifest=root/'assets/app-icons/sources.json'
previous={v['id']:v for v in json.loads(manifest.read_text())} if manifest.exists() else {}
ALLOWED_HOSTS={'www.google.com','icons.duckduckgo.com'}
def fetch(url,limit=1_000_001):
 """HTTPS only, to the two icon services, via the system curl with the protocol pinned on redirects too."""
 parts=urlparse(url)
 if parts.scheme!='https' or parts.hostname not in ALLOWED_HOSTS: raise ValueError('refusing icon source '+url)
 result=subprocess.run(['/usr/bin/curl','--silent','--show-error','--fail','--location','--max-redirs','3','--proto','=https','--proto-redir','=https','--max-time','30','--max-filesize',str(limit),'--user-agent','just-zen-icons','--',url],capture_output=True,check=True)
 return result.stdout
def download(app):
 host={'Proton Mail':'proton.me','WhatsApp':'whatsapp.com','GitLab':'gitlab.com'}.get(app['name'],urlparse(app['url']).hostname)
 url=previous.get(app['id'],{}).get('source') or 'https://www.google.com/s2/favicons?domain='+quote(host)+'&sz=128'
 target=root/app['icon']
 if target.exists() and target.read_bytes().startswith(b'\x89PNG'): return {'id':app['id'],'source':url,'bytes':target.stat().st_size}
 try:
  data=fetch(url)
 except Exception:
  url='https://icons.duckduckgo.com/ip3/'+quote(host)+'.ico'
  data=fetch(url)
 if len(data)>1_000_000: raise ValueError(app['name']+': oversized icon')
 target=root/app['icon'];target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
 if not data.startswith(b'\x89PNG\r\n\x1a\n'):
  with tempfile.NamedTemporaryFile(suffix='.ico') as raw:
   raw.write(data);raw.flush();subprocess.run(['sips','-s','format','png',raw.name,'--out',str(target)],check=True,stdout=subprocess.DEVNULL)
 if not target.read_bytes().startswith(b'\x89PNG'): raise ValueError(app['name']+': invalid image')
 return {'id':app['id'],'source':url,'bytes':len(data)}
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
 futures={pool.submit(download,a):a for a in apps};results=[];errors=[]
 for future in concurrent.futures.as_completed(futures):
  try: results.append(future.result())
  except Exception as error: errors.append(futures[future]['name']+': '+str(error))
 if errors: print('Missing icons:',errors);raise SystemExit(1)
(root/'assets/app-icons/sources.json').write_text(json.dumps(results,indent=2)+'\n')
print('Downloaded',len(results),'icons;',sum(a['bytes'] for a in results),'bytes')
