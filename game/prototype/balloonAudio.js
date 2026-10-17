// 車を聞き手とする気球音。カメラのズーム・俯瞰には左右されない。
// 距離には高度差も含め、25m以内は原音量、300mで無音になる。
export function balloonSoundMix(sources, listener) {
  let burnerPower = 0, ripPower = 0;
  for (const { pos, burner, rip } of sources) {
    const distance = Math.hypot(pos.x - listener.x, pos.y + 2.5 - listener.y, pos.z - listener.z);
    const fade = Math.max(0, Math.min(1, (300 - distance) / 275));
    const volume = fade * fade;
    if (burner) burnerPower += (0.4 * volume) ** 2;
    if (rip) ripPower += (0.25 * volume) ** 2;
  }
  // 複数機が接近しても音が大きくなりすぎないよう、合成音量に上限を設ける。
  return { burner: Math.min(0.55, Math.sqrt(burnerPower)),
    rip: Math.min(0.3, Math.sqrt(ripPower)) };
}
