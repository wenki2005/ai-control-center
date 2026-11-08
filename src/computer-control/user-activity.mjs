import {execFile} from 'node:child_process';import{promisify}from'node:util';
const executeDefault=promisify(execFile);
// Read only the OS input-event tick. No key, pointer, window or document content.
const code=`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class HubInputTick{[StructLayout(LayoutKind.Sequential)]public struct Info{public uint cbSize;public uint dwTime;}[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref Info info);public static uint Read(){Info i=new Info();i.cbSize=(uint)Marshal.SizeOf(i);if(!GetLastInputInfo(ref i))throw new Exception("Input activity unavailable");return i.dwTime;}}';[HubInputTick]::Read()`;
export async function sampleLocalInputTick({platform=process.platform,execute=executeDefault}={}){
 if(platform!=='win32')return null;
 try{const r=await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{windowsHide:true,timeout:1800,maxBuffer:4096,encoding:'utf8'});const text=r.stdout.trim();if(!/^\d{1,10}$/.test(text))return null;const tick=Number(text);return tick<=0xffffffff?tick:null;}catch{return null;}
}
