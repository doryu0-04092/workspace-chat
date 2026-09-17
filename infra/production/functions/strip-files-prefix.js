// CloudFront Functions（cloudfront-js-2.0）。/files/* のビヘイビアの viewer-request で動く（infra/production/delivery.tf）。
// 添付の配信 URL（/files/workspace/{ws}/channel/{ch}/{UUID}/{ファイル名}）から /files を剥がし、S3 のキーと同じ形にする
// （要件定義書 4.3。オリジンパスでは剥がせない）。
//
// 配信用のキーの形に当たらない URI は、剥がさずに 404 を返す——区切りの `.`・`..`・空の区切り（`//`）・`%` による符号化
// （要件定義書 4.3 の「確かめる URL の形」）と、許可リストの外の文字を含むもの。配信用のキーはすべてサーバーが組み立て、
// 区切りはどれも英数字・`_`・`-` で始まり、英数字・`.`・`_`・`-` だけからなる（ファイル名の置換は機能一覧 11.1。先頭の `.` は `_` に置き換える）。
// 署名付き Cookie の Resource の照合と、S3 がオリジンへ渡ったパスをどのキーと読むかは未確認であり（要件定義書 4.3）、ここはその多層の防御である。
// 踏むと壊れる: 配信用のキーの形（区切りの文字）を広げるときは、ここの許可リストも直す（直さないと、その添付が 404 になる）。
// 検査は scripts/cloudfront-functions.test.mjs。
// handler は CloudFront Functions が名前で呼ぶ大域の入口であり、このファイルの中からは呼ばない。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function handler(event) {
  var request = event.request;
  if (!/^\/files(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/.test(request.uri)) {
    return { statusCode: 404, statusDescription: 'Not Found' };
  }
  request.uri = request.uri.slice('/files'.length);
  return request;
}
