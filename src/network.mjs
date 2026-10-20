import { execFileSync } from 'node:child_process';
export function existingSystemProxy() {
  if(process.env.HTTPS_PROXY || process.env.HTTP_PROXY)return undefined; // child already inherits explicit configuration
  if(process.platform!=='win32')return undefined;
  try {
    const value=execFileSync('powershell.exe',['-NoProfile','-Command',
      String.raw`$p=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings';if($p.ProxyEnable -eq 1){Write-Output $p.ProxyServer}`],
      {encoding:'utf8',windowsHide:true,timeout:4000,stdio:['ignore','pipe','pipe']}).trim();
    if(!value)return undefined;
    const address=value.includes('=')?(value.split(';').find(part=>part.startsWith('https=')) || value.split(';').find(part=>part.startsWith('http=')))?.split('=')[1]:value;
    if(!address)return undefined;
    const url=new URL(address.includes('://')?address:'http://'+address);
    return ['http:','https:'].includes(url.protocol)?url.href:undefined;
  }catch{return undefined;}
}
