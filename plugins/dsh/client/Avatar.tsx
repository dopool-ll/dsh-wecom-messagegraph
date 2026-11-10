export function Avatar({name, size = 'normal'}: {name: string; size?: 'normal' | 'large' | 'small'}) {
  const tone = [...name].reduce((total, letter) => total + letter.codePointAt(0)!, 0) % 5;
  return <span aria-hidden="true" className={`avatar tone-${tone} ${size}`}>{Array.from(name.trim()).slice(0, 2).join('') || '企'}</span>;
}
