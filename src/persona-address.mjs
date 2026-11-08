// Honor the active card; Mornye's form of address is not shared user memory.
export function personaAddress(persona={}) {
  const address=String(persona.address||'').trim();
  const mornye=persona.personaId?persona.personaId==='mornye':persona.name==='助手';
  return !mornye&&address.includes('你')?'':address;
}

export function personaGreeting(persona) {
  const address=personaAddress(persona);
  return address?`${address}，`:'';
}
