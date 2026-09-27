# 우리집 경비

매달 공동 경비를 입력하고, 계좌별 합계를 카카오뱅크 이체용으로 복사하는 모바일 웹앱.

- 앱: GitHub Pages (이 저장소, 정적 파일만)
- 데이터: 비공개 저장소 `spring7day/family-ledger-data` (`settings.json`, `months/YYYY-MM.json`)
- 로그인: 공유 비밀번호로 `config.js` 안의 암호화된 GitHub 토큰을 풀어 데이터 저장소에 접근

## 토큰/비밀번호 교체
```
LEDGER_PW='새비밀번호' LEDGER_TOKEN='github_pat_...' node tools/make-config.mjs > config.js
git commit -am "config 갱신" && git push
```
토큰은 family-ledger-data 저장소 Contents Read/Write 권한만 준 fine-grained 토큰을 권장.
