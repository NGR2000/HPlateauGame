// 新ゲームモード「マーカー回収レース」: ダミー気球のオートパイロット。
//
// **気球の物理そのものには触れない。** main.js の stepPhysics(浮力・風の反映・
// 接地判定)はプレイヤー操縦時と完全に同じものを使う。このモジュールが決めるのは
// 「バーナー(input.burner)とリップライン(input.rip)を、キーボードの代わりに
// 何が true/false にするか」だけ。マーカーの投下タイミングも同様に「要求する」だけで、
// 実際の投下(dropMarker)・落下物理(stepMarker)は main.js 側の既存実装を呼ぶ。
//
// 設計方針(先読みゲームとしての狙い):
//   プレイヤーは「気球が今どの高度でどちらへ流れているか」をパイバル表と見た目から
//   読み、着地点を予測して先回りする。そのため、この気球は**気まぐれに動かない**
//   (毎フレーム巡航高度を変えたりしない)。巡航高度は一定間隔でしか選び直さないので、
//   プレイヤーが「しばらくこの高度・この向きで飛ぶ」と当てを付けられる状態を保つ。

const DEFAULT_CRUISE_SCAN_FT = [500, 1000, 1500, 2000, 3000, 5000]; // 巡航候補高度
const DEADBAND_M = 15;     // 目標高度からの不感帯(この中では焚きもリップもしない)
const VY_GUARD_MPS = 2.5;  // 昇降が既にこの速さで目標へ向かっているなら追加入力しない(オーバーシュート防止)
const RESCAN_S = 25;       // 巡航高度を選び直す間隔(秒)。頻繁に変えるとプレイヤーが読めなくなる

/**
 * ダミー気球のオートパイロットを作る。
 *
 * @param {object} opts
 * @param {(altM:number,x:number,z:number)=>{dir:number,kt:number,vx:number,vz:number}} opts.windAt
 *   main.js の windAt と同じシグネチャ。地点・高度ごとの風を返す
 * @param {number} opts.targetX ターゲット(マーカーを落としたい場所の目安)
 * @param {number} opts.targetZ
 * @param {number} [opts.M2FT=3.28084]
 * @param {number} [opts.dropDistM=400] ターゲットからこの距離まで近づいたら投下を要求する。
 *   **ちょうど真上で投下するわけではない**(そうすると先読みの意味が薄れる)。
 *   風で流れることを見込んだ距離感は、パイバル表を見て早めに動くプレイヤー側の腕の見せどころ
 * @param {number[]} [opts.cruiseScanFt] 巡航高度の候補(ft)
 * @returns {{control:Function, shouldDrop:Function, cruiseFt:()=>number|null}}
 */
export function createBalloonAutopilot({
  windAt, targetX, targetZ, M2FT = 3.28084, dropDistM = 400,
  cruiseScanFt = DEFAULT_CRUISE_SCAN_FT,
}) {
  let cruiseFt = null;
  let sinceScan = 1e9;   // 初回は即座に選ぶ
  let dropped = false;
  let noticeSent = false;

  // 現在地からターゲットへ、いちばん近い方位で運んでくれる高度を選ぶ。
  // 「方位の近さ」と「風速」の両方を見る(弱い風だと方位が合っていても進まない)
  function pickCruiseAltitude(x, z) {
    const toTarget = Math.atan2(targetX - x, -(targetZ - z)); // 目的地への方位
    let best = cruiseScanFt[0], bestScore = -Infinity;
    for (const ft of cruiseScanFt) {
      const w = windAt(ft / M2FT, x, z);
      if (w.kt < 1) continue; // ほぼ無風の高度は候補にしない
      const blowTo = Math.atan2(w.vx, -w.vz); // 風が吹いていく向き
      let diff = Math.abs(toTarget - blowTo);
      while (diff > Math.PI) diff -= Math.PI * 2; // -π..π に畳んでから絶対値
      diff = Math.abs(diff);
      const score = Math.cos(diff) * w.kt; // 向きが合っていて速いほど高スコア
      if (score > bestScore) { bestScore = score; best = ft; }
    }
    return best;
  }

  return {
    /**
     * 毎フレーム呼ぶ。戻り値をそのまま main.js の input.burner / input.rip に代入する想定
     * @param {{x:number,y:number,z:number}} pos 気球の現在位置(標高m)
     * @param {number} vy 現在の昇降速度(m/s)
     * @param {number} dt 経過秒
     */
    control(pos, vy, dt) {
      sinceScan += dt;
      if (cruiseFt === null || sinceScan >= RESCAN_S) {
        cruiseFt = pickCruiseAltitude(pos.x, pos.z);
        sinceScan = 0;
      }
      const targetM = cruiseFt / M2FT;
      const diffM = targetM - pos.y;
      // ヒステリシス: 不感帯の外に出ていて、かつ既に目標方向へ十分な速さで
      // 動いていないときだけ入力する(焚きすぎ・抜きすぎで往復するのを防ぐ)
      const burner = diffM > DEADBAND_M && vy < VY_GUARD_MPS;
      const rip = diffM < -DEADBAND_M && vy > -VY_GUARD_MPS;
      return { burner, rip };
    },

    // 投下成功時だけ markDropped を呼ぶ。離陸前の拒否で投下機会を失わない。
    shouldDrop(pos) {
      if (dropped) return false;
      const d = Math.hypot(pos.x - targetX, pos.z - targetZ);
      return d <= dropDistM;
    },

    markDropped() { dropped = true; },

    // 現在の風が続く場合の投下範囲への到達予測(ゲーム内秒)。
    dropNotice(pos) {
      if (dropped || noticeSent) return null;
      const w = windAt(pos.y, pos.x, pos.z);
      const x = pos.x - targetX, z = pos.z - targetZ;
      const c = x * x + z * z - dropDistM * dropDistM;
      let seconds = 0;
      if (c > 0) {
        const a = w.vx * w.vx + w.vz * w.vz;
        const b = x * w.vx + z * w.vz;
        const disc = b * b - a * c;
        if (a <= 0 || b >= 0 || disc < 0) return null;
        seconds = c / (-b + Math.sqrt(disc));
      }
      if (!Number.isFinite(seconds) || seconds > 60) return null;
      noticeSent = true;
      return seconds;
    },

    cruiseFt: () => cruiseFt,
  };
}
