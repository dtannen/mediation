const ENTITY_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ENTITY_MAP[ch] || ch);
}

function renderInline(value) {
  let text = escapeHtml(value);

  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Images are blocked explicitly.
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => {
    const safeAlt = escapeHtml(alt || 'image');
    const safeSrc = escapeHtml(src || '');
    return `<span class="md-image-blocked" title="External images blocked">[blocked ${safeAlt}${safeSrc ? ` - ${safeSrc}` : ''}]</span>`;
  });

  // Safe links only.
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    const rawHref = String(href || '').trim();
    const safeHref = /^(https:\/\/|mailto:)/i.test(rawHref) ? rawHref : '#blocked:';
    return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label || '')}</a>`;
  });

  return text;
}

export function renderMarkdownUntrusted(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  const lines = raw.split(/\r?\n/);
  const blocks = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) {
      return;
    }
    blocks.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (trimmed.startsWith('- ')) {
      flushParagraph();
      const item = renderInline(trimmed.slice(2));
      const prev = blocks[blocks.length - 1] || '';
      if (prev.startsWith('<ul>') && prev.endsWith('</ul>')) {
        blocks[blocks.length - 1] = prev.replace('</ul>', `<li>${item}</li></ul>`);
      } else {
        blocks.push(`<ul><li>${item}</li></ul>`);
      }
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();

  return blocks.join('');
}
