import type { DesignAgentContact } from '../api/contractors.js';

export function formatContactPhone(phone: string) {
  return phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '+1 ($1) $2-$3');
}

function escapeVCard(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

export function createFormVCard(agent: DesignAgentContact) {
  const lines = [
    'BEGIN:VCARD', 'VERSION:3.0', `FN:${escapeVCard(agent.name)}`, `N:;${escapeVCard(agent.name)};;;`,
    'ORG:FORM', 'TITLE:Your AI kitchen design agent', `TEL;TYPE=CELL,WORK:${escapeVCard(agent.phone)}`,
    ...(agent.email ? [`EMAIL;TYPE=WORK:${escapeVCard(agent.email)}`] : []),
    ...(agent.website ? [`URL:${escapeVCard(agent.website)}`] : []),
    'NOTE:Kitchen design support for contractors. Text kitchen photos and design ideas to FORM. For shared design feedback start an iMessage group with your homeowner first.', 'END:VCARD',
  ];
  // vCard 3.0 requires CRLF and folding at 75 octets (including continuation whitespace).
  return lines.map((line) => {
    let folded = '';
    let length = 0;
    for (const character of line) {
      const bytes = new TextEncoder().encode(character).length;
      if (length + bytes > 75) { folded += '\r\n '; length = 1; }
      folded += character;
      length += bytes;
    }
    return folded;
  }).join('\r\n') + '\r\n';
}

export function downloadFormContact(agent: DesignAgentContact) {
  const url = URL.createObjectURL(new Blob([createFormVCard(agent)], { type: 'text/vcard;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'FORM.vcf';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Leave enough time for Safari to open the file before releasing the URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
