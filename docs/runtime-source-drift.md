# 稼働中の静的資産とGit記録の照合

## 事前評価と計画（2026-11-04）

優先度89点（利用価値33/35、共通性22/25、実現性17/20、検証・復旧17/20）。複数のアプリで稼働中のコードと参照先の差を把握できれば、誤って別の変更を上書きする前に確認できる。静的UIの有無や過去観測との比較とは異なり、固定したGit commitと配信されたbytesを照合する。Jev 1.14.0は合成仕様に対し、この判定対象を独立と分類した。採点は親の事前判断で、時間短縮や障害率の実測値ではない。

実装対象は明示されたアプリの少数の静的HTML・CSS・JS・履歴JSONとする。認証なしGET、証明書検証、接続先とパスの固定、リダイレクトとプロキシの不使用、応答サイズ・時間の上限を設ける。Git側はローカルの指定リポジトリの固定commitだけを読み、コード本文や利用者データを出力しない。取得失敗やGitの対象欠落は「未確認」とし、差異と区別する。結果は自動反映や復元には使わない。

この案は既存の43/50正式台帳や既存の追加7候補へ自動加算しない。実配信との同時性、生成された資産、物理端末、コードの正当性や完全性をhash一致だけで保証しない。

## 使い方

ローカルに対象のGitリポジトリがあり、対象アプリへ到達できる端末で、明示的に実行する。対象は `toeic-study`、`equalification`、`duo-study`、`photo-editing`、`video-player-2d` に限定している。

```sh
python3 tools/compare_runtime_source.py --app duo-study --repo /path/to/duo-learning --ca-file /path/to/lan-ca.pem
python3 tools/compare_runtime_source.py --app photo-editing --repo /path/to/photo-editing --ca-file /path/to/lan-ca.pem --commit FULL_COMMIT_HASH
python3 tools/compare_runtime_source.py --app video-player-2d --repo /path/to/video-player-2d --ca-file /path/to/lan-ca.pem
python3 tools/compare_runtime_source.py --app toeic-study --repo /path/to/webtest --ca-file /path/to/lan-ca.pem
python3 tools/compare_runtime_source.py --app equalification --repo /path/to/equalification --ca-file /path/to/lan-ca.pem
```

`--commit` を省略すると開始時のHEADを固定し、それぞれのGit blobと許可済み静的応答のSHA-256を比較する。作業ツリーの未コミット変更は比較しない。ローカル `origin` の設定値がアプリに対応するGitHubリポジトリであることを検査するが、設定文字列の一致はリポジトリの真正性証明ではない。Gitへのネットワーク接続は行わない。

結果は標準出力のJSONで、`match`、`different`、`unknown` と件数・理由・対象hashを含む。終了コードは全件一致が0、差異が1、差異がなく未確認を含むか入力条件を満たさない場合は2。差異と未確認が混在するときも個別件数を参照する。コード本文・応答本文・ローカルパス・例外本文・認証情報は結果へ出さないが、hashは対象の指紋となるため、結果の共有先は利用者が判断する。

公開CAの追加指定は既存の信頼ストアを補うもので、証明書検証を無効にしない。対象URLはアプリごとに固定し、利用者データAPI・画像・任意のURLは取得しない。JSONは映像の本棚の静的な履歴データだけを対象とする。E資格の版付きURLは登録時の版に固定され、版が切り替わり取得できなくなった場合は未確認として扱う。GET以外、認証情報、プロキシ、リダイレクト追跡は使わない。200以外、認証エラー、不正なContent-Type、圧縮、長さ不明・不足、1MiB超、期限超過、Git側の欠落・シンボリックリンクは未確認とする。応答は1件ずつ取得するため、全資産が同一瞬間の状態とは限らない。

## 確認記録（2026-11-04）

- 合成Git・ローカルHTTPを用い、一致・差異・認証拒否・リダイレクト非追跡・サイズ・欠落・不完全応答・タイムアウト・Gitシンボリックリンク・commit固定・CLI終了コードを確認。MacのPython全72試験と、221のPython 3.9で本機能の11試験が成功した。
- 明示実行した実環境では、TOEICの7資産、E資格の10資産、DUOの4資産、映像の本棚の8資産はそれぞれ指定したGit commitと一致。Photo Editingの5資産はローカルGit HEADとの比較で1一致・4差異だった。これらは取得時点の比較で、差異が不具合・未保存・未配備のいずれかを示すものではない。利用者データAPIへのアクセスやコードの変更は行っていない。
- GitHub Actionsでは合成テストのみを実行し、LANには接続しない。定期実行やサービスの自動起動は登録していない。
- FUP-05の静的コントロール点検、FUP-06の観測結果間の前回比較とは比較対象が異なる。既存台帳との統合は別途必要であり、件数に自動加算しない。Jev 1.14.0の今回の合成判定は入力587・出力96トークンで、GPT利用削減量ではない。
