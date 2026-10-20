import { redact } from '../redact.mjs';

// Keep the failure location in the local event journal. UI errors continue to
// use their existing short summaries; this diagnostic is never a user report.
export function taskFailureDiagnostic(error) {
  const describe=(value,depth=0)=>({
    name:String(value?.name || 'Error').slice(0,80),
    message:String(redact(String(value?.message ?? value ?? 'Unknown error'))).slice(0,1500),
    ...(typeof value?.stack==='string'?{stack:String(redact(value.stack)).slice(0,5000)}:{}),
    ...(value?.code?{code:String(redact(String(value.code))).slice(0,100)}:{}),
    ...(value?.cause&&depth<2?{cause:describe(value.cause,depth+1)}:{}),
  });
  return {...describe(error),...(error?.cause?{cause:describe(error.cause)}:{})};
}
