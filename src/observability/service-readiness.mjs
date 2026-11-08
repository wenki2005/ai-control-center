// One missed local probe means "checking"; sustained failures mean offline.
// This observes HTTP readiness only and never stands in for model completion.
export class ServiceReadiness {
  constructor({failureThreshold=3}={}) {this.failureThreshold=failureThreshold;this.failures=new Map();}
  observe(service,ok) {
    const failures=ok?0:(this.failures.get(service)||0)+1;
    this.failures.set(service,failures);
    return ok?'online':failures>=this.failureThreshold?'offline':'checking';
  }
}
