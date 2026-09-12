export function normalizeMeaning(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^(?:n|v|vt|vi|adj|adv|prep|conj|art)\.\s*/i, '')
    .replace(/[\s\u3000，。！？、；："'“”‘’（）()[\]【】《》,.!?;:<>/\\-]/g, '');
}
