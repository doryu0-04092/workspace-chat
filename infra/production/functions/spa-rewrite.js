// CloudFront Functions（cloudfront-js-2.0）。既定のビヘイビアの viewer-request で動く（infra/production/delivery.tf）。
// 画面の URL（拡張子の無いパス。例: /workspaces/<id>/channels/<id>）を、web の入口（/index.html）に書き換える。
// 拡張子のあるパス（/assets/index-<hash>.js・/favicon.ico）はそのままバケットへ渡す。
// 踏むと壊れる: web の画面の URL の区切りに「.」を含めない（含めると書き換えられず、バケットに無いキーとして 403 になる）。
// 検査は scripts/cloudfront-functions.test.mjs。
// handler は CloudFront Functions が名前で呼ぶ大域の入口であり、このファイルの中からは呼ばない。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function handler(event) {
  var request = event.request;
  if (!request.uri.includes('.')) {
    request.uri = '/index.html';
  }
  return request;
}
