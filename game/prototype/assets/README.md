# 創作の世界の提供アセット

## チェイスカー

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

## チームの熱気球 MV56b

ユーザー提供の `MV56b_hot_air_balloon.zip` 内のBlenderファイルを
`source/MV56b_hot_air_balloon.blend` に保存しています。
ゲーム用は `MV56b_hot_air_balloon.glb` です。
床・照明・カメラを除き、球皮、バスケット、ツインバーナーと配色を保持しています。
曲線の細い断面を軽量化し、材質ごとにまとめて書き出します。メートル寸法はそのままです。

```sh
blender --background --disable-autoexec --python tools/export_team_balloon.py -- \
  game/prototype/assets/source/MV56b_hot_air_balloon.blend \
  game/prototype/assets/MV56b_hot_air_balloon.glb
```

このモデルは創作側の自分のチーム1機にだけ使い、残りの5機は別配色の軽量モデルです。
「自分のチーム / MV56b」の札を付け、遠くでも見分けられるようにしています。

## 街の建物

ユーザーが提供したモデルをメートル寸法のまま変換しています。配置・回転・大きさは街のデータ側で扱います。

| 元データ（source/） | ブラウザ用 | 幅 × 奥行 × 地上高さの目安 |
| --- | --- | --- |
| tokyo_station_marunouchi.blend | tokyo_station.glb | 335.58 × 38.52 × 35m |
| tokyo_tower.blend | tokyo_tower.glb | 88.22 × 88.22 × 334m |
| sports-center.ifc | sports_center.glb | 28.6 × 45.8 × 15.7m（地下部分あり） |
| exterior-layout.ifc | exterior.glb | 8.4 × 9.4 × 36.18m |

Blenderは表示対象のメッシュをまとめ、展示用の地面・照明・カメラを除きます。東京タワーの広大なプレビュー床も除外しています。原点は平面中央・地面に合わせ、Y-upで書き出します。IFCは地盤のZ=0を維持し、地下部分も保存します。参照用の敷地・道路と開口要素を除き、材質でまとめます。

```sh
blender --background --disable-autoexec --python tools/export_city_blend.py -- \
  game/prototype/assets/source/tokyo_station_marunouchi.blend \
  game/prototype/assets/tokyo_station.glb
blender --background --disable-autoexec --python tools/export_city_blend.py -- \
  game/prototype/assets/source/tokyo_tower.blend \
  game/prototype/assets/tokyo_tower.glb
python tools/export_city_ifc.py game/prototype/assets/source/sports-center.ifc game/prototype/assets/sports_center.glb
python tools/export_city_ifc.py game/prototype/assets/source/exterior-layout.ifc game/prototype/assets/exterior.glb
```

Blender 5.2以降が必要です。IFC変換には `ifcopenshell`、`numpy`、`trimesh` を使います（確認した環境はIfcOpenShell 0.9.0.post1、trimesh 5.1.1）。通常のゲーム起動に変換ツールは不要です。

お寺は増上寺の参考スクリーンショットに着想を得た簡易モデルです。実物の正確な再現ではありません。住宅・店舗・倉庫・公園などとともに `cityView.js` で生成します。`exterior.zip` は建物生成プログラムの参考資料で、ゲームには同時提供されたIFCの変換結果を組み込みます。
