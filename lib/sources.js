// 市況・業界リサーチで参照を許可するドメイン。
// Web検索ツールの allowed_domains に渡すと、ここに無いサイトは
// 検索結果としてモデルに届かない。「Xや個人ブログを見ないでください」と
// お願いするのではなく、構造的に入らないようにするための仕組み。
//
// 分類は利用者の選択に対応:
//   1. 一次メディア（ブルームバーグ・ロイター・日経）
//   2. 証券会社のリサーチ
//   3. 適時開示（TDnet・EDINET・JPX）
//   4. 業界・予想のまとめ（東洋経済・四季報・QUICK・MINKABU）

export const SOURCE_GROUPS = {
  一次メディア: [
    "bloomberg.co.jp",
    "bloomberg.com",
    "nikkei.com",
    // ロイター(reuters.com / jp.reuters.com)はAnthropicのクローラーを拒否しており、
    // allowed_domains に入れるとリクエスト自体が400で弾かれるため入れられない。
  ],
  証券会社: [
    "nomura.co.jp",
    "nomuraholdings.com",
    "daiwa.jp",
    "daiwa-grp.jp",
    "mizuho-sc.com",
    "mizuhogroup.com",
    "smbcnikko.co.jp",
    "sc.mufg.jp",
    "monex.co.jp",
    "rakuten-sec.co.jp",
    "sbisec.co.jp",
    "matsui.co.jp",
    "ichiyoshi.co.jp",
    "tokaitokyo.co.jp",
    "okasan.co.jp",
    "iwaicosmo-sec.jp",
    "marusan-sec.co.jp",
  ],
  適時開示: [
    "release.tdnet.info",
    "www.release.tdnet.info",
    "disclosure2.edinet-fsa.go.jp",
    "disclosure.edinet-fsa.go.jp",
    "jpx.co.jp",
  ],
  業界まとめ: [
    "toyokeizai.net",
    "shikiho.toyokeizai.net",
    "quick.co.jp",
    "minkabu.jp",
    "kabutan.jp",
  ],
};

export const ALLOWED_DOMAINS = Object.values(SOURCE_GROUPS).flat();

// 画面や出力に載せる説明文（何を見て、何を見ていないかを利用者に示す）
export const SOURCE_SUMMARY =
  "ブルームバーグ・日経／証券会社のリサーチ／適時開示・TDnet・EDINET／東洋経済・四季報・QUICK・MINKABU";
