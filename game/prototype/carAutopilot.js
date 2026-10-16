// 新ゲームモード「マーカー回収レース」: 自由走行の車を自動で走らせる簡易オートパイロット。
//
// **道路グラフは見ない。**playerCar.js のフェーズ1(自由走行)と同じ地形の上を、
// 目標地点(既定では気球の直下)へ向けてアクセル・ハンドルの2軸で近づけるだけの単純な追尾。
// chasecar.js の A* 追尾とは別物で、あくまで「参考動作をするダミー車」用の簡易実装。
//
// playerCar.js の update(dt, {throttle, steer}) にそのまま渡せる形で {throttle, steer} を返す。

const ARRIVE_M = 150;          // 既定: これより近づいたら追いかけるのをやめてその場で待つ
const STEER_GAIN = 1.6;        // 目標方位とのズレ → ハンドル量への比例ゲイン
const TURN_SLOWDOWN_DEG = 60;  // 進行方向とのズレがこれを超えたら、大回りしないようアクセルを落とす

/**
 * @param {{x:number,z:number,headingDeg:number}} car playerCar.js の info() の戻り値
 * @param {number} targetX 追いかける/向かう地点(気球の現在位置、ターゲット固定座標、等)
 * @param {number} targetZ
 * @param {number} [arriveM=ARRIVE_M] これより近づいたら停止して待つ距離(m)。
 *   2号車(ターゲットへ向かう車)は chasecar.js の standoffM(100m)に合わせるなど、
 *   呼び出し側で用途に応じて変えられる
 * @returns {{throttle:number, steer:number}}
 */
export function carAutopilotControl(car, targetX, targetZ, arriveM = ARRIVE_M) {
  const dx = targetX - car.x;
  const dz = targetZ - car.z;
  const dist = Math.hypot(dx, dz);
  if (dist < arriveM) return { throttle: 0, steer: 0 };

  // このコードベースの座標系(x:東+, z:南+)における方位。chasecar.js の bearing() と同じ式
  const wantHeading = Math.atan2(dx, -dz);
  const curHeading = (car.headingDeg * Math.PI) / 180;
  let diff = wantHeading - curHeading;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;

  const steer = Math.max(-1, Math.min(1, (diff * STEER_GAIN) / (Math.PI / 2)));
  const diffDeg = Math.abs((diff * 180) / Math.PI);
  const throttle = diffDeg > TURN_SLOWDOWN_DEG ? 0.4 : 1; // 大きく向きを変える最中は速度を落とす
  return { throttle, steer };
}
