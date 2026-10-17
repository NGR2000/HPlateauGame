# 創作の世界の車両

`sky_chase_car.glb` は、ユーザー提供の `source/sky_chase_car.blend` から書き出したゲーム用モデルです。
創作の世界のプレイヤー車両（1号車）にだけ使います。実際のデータの世界と、参考走行する2・3号車は標準モデルを使います。

- 元ファイル：Blender 5.2形式。編集用としてそのまま保存しています。
- 変換：Blender 5.2.1 LTSのglTFエクスポーター。展示用の床・台座・タイトル・照明・カメラは含めません。
- 文字はメッシュ化し、モディファイアを適用。材質ごとにまとめ、外部テクスチャや追加デコーダーを不要にしています。
- 大きさは元のメートル寸法を維持。ゲーム内で前方を-Z、上を+Y、タイヤ底面をY=0に合わせています。
- 新モデルのタイヤ底面は地形に合わせ、既存の道路描画用オフセットを見た目だけで相殺しています。
- 加減速・旋回・地形上の移動は共通処理です。

リポジトリルートから再変換できます（Blender 5.2以降が必要です）。

```sh
blender --background --disable-autoexec --python tools/export_chase_car.py -- \
  game/prototype/assets/source/sky_chase_car.blend \
  game/prototype/assets/sky_chase_car.glb
```
