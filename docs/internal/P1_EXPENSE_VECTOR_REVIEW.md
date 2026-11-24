# 新增消费共同样例的移动回执

桌面提交 `fb7ecc0c145486e761567ffc11fdce9198cae907`，样例文件 `backend/tests/fixtures/p1_expense_create_vectors.json`，原字节 SHA-256 为 `2679ab4a3461be7b039a0686d6436640db32e4bbc1af700bd9f565a3a7e76bcb`。桌面检查器从该提交的独立归档执行，10 场景 36 步通过。移动业务代码及 APK 基线为 `0b43cffd2ae285555784f3980101b0554f9f05b0`；本次仅增加验收入口。以下为两种移动实现的观察值，尚未分配共享版本。

## 逐项结果

“既有”取自移动基线的同一业务路径，可复用等价虚构 ID，不表示当时读过本次 JSON。“补测”从指定 JSON 构造步骤，按场景顺序执行。R1、R2 各自绑定在本端当次运行实际产生的版本，表中“重放 R1”表示没有新增记录。成功新增包括 changed 效果，版本、消费、回执及待发送各增一；拒绝、查询及重放的四项增量均为零。EC10 宿主第一步的实际增量单列。移动写入成功返回 kind=committed，查询成功返回 state=committed。桌面成功回执另带操作身份、意图摘要和目标字段，移动查询的 receipt 投影只有 effect 与 result_revision_id。

| 场景与 JSON step.name | 桌面实读 | 移动宿主实测 | Android 实测 | 移动证据 |
|---|---|---|---|---|
| EC01 create_lunch | 新增 R1 | 新增 R1 | 新增 R1 | 既有 |
| EC02 abort_before_commit | exit_code=86，stdout_empty=true | SIGKILL，重开为初版 | 主进程终止，重开为初版 | 既有 |
| EC02 lookup_after_abort | not_found_at_settled_read | not_found_at_settled_read | not_found_at_settled_read | 既有 |
| EC02 retry_same_key | 新增 R1 | 新增 R1 | 新增 R1 | 既有 |
| EC03 abort_after_commit | exit_code=86，stdout_empty=true，已提交 R1 | SIGKILL，重开有 R1 | 桥应答前终止，重开有 R1 | 既有中断；补测后续步骤时以普通提交建立同状态 |
| EC03 lookup_committed_after_restart | committed / changed，R1 | committed / changed，R1 | committed / changed，R1 | 既有冷重开；另补测结果投影 |
| EC03 replay_reordered_keys | 重放 R1 | 重放 R1 | 重放 R1 | 补测，第二笔创建前 |
| EC03 advance_branch_head | 晚餐 4200 分，新增 R2 | 晚餐 4200 分，新增 R2 | 晚餐 4200 分，新增 R2 | 补测，旧场景以更正备注推进版本 |
| EC03 replay_original_after_head_advance | 重放 R1 | 重放 R1 | 重放 R1 | 补测，两笔仍在，当前头保持 R2 |
| EC04 seed_first | 新增 R1 | 新增 R1 | 新增 R1 | 既有 |
| EC04 conflict_amount_8636 | intent_conflict | intent_conflict | intent_conflict | 既有 |
| EC04 conflict_allow_shared_receipts | intent_conflict | intent_conflict | intent_conflict | 既有 |
| EC05 seed_first | 新增 R1 | 新增 R1 | 新增 R1 | 既有 |
| EC05 stale_baseline | baseline_conflict，含当前 R1 | baseline_conflict，无当前版本字段 | baseline_conflict，无当前版本字段 | 既有 |
| EC05 duplicate_entity_on_current_head | entity_exists | entity_exists | entity_exists | 既有 |
| EC06 seed_first | 新增 R1 | 新增 R1 | 新增 R1 | 既有 |
| EC06 committed_key_wrong_branch | unauthorized | denied | scope_mismatch | 既有，新／旧键均在查回执前拒绝 |
| EC06 new_key_wrong_travel | unauthorized | denied | scope_mismatch | 既有 |
| EC06 lookup_wrong_device | unauthorized | denied | denied | 既有，无回执 |
| EC06 lookup_without_permission | unauthorized | denied | denied | 既有，无回执 |
| EC07 lookup_while_write_locked | unknown / storage_busy | unknown / storage_busy | pending_busy | 补测，Android 用独立 sqlite3 进程持有实际新增库写锁 |
| EC07 lookup_after_lock_released | not_found_at_settled_read | not_found_at_settled_read | not_found_at_settled_read | 补测，同一库、同一查询 |
| EC08 create_1999th | 新增 R1 | 新增 R1 | 新增 R1 | 补测，起始 1998 笔 |
| EC08 create_2000th | 新增 R2 | 新增 R2 | 新增 R2 | 补测 |
| EC08 reject_2001st | expense_limit_exceeded | expense_count | expense_count | 补测 |
| EC08 replay_1999th_while_at_2000_cap | 重放 R1 | 重放 R1 | 重放 R1 | 补测，旧场景重放第 2000 笔 |
| EC09 amount_zero | integer_range | integer_range | integer_range | 既有 |
| EC09 amount_bool_true | type | type | type | 既有 |
| EC09 amount_fraction_1_25 | integer_range | integer_range | integer_range | 既有 |
| EC09 amount_overflow_10000000000 | integer_range | integer_range | integer_range | 既有 |
| EC10 non_null_paid_on | unsupported_capability | committed / changed，四项各 +1 | unsupported_capability | 补测，宿主实存 2026-11-23 |
| EC10 non_null_day | unsupported_capability | baseline_conflict | unsupported_capability | 补测 |
| EC10 non_null_activity_id | unsupported_capability | baseline_conflict | unsupported_capability | 补测 |
| EC10 non_empty_receipt_ids | unsupported_capability | baseline_conflict | unsupported_capability | 补测 |
| EC10 non_null_budget_item_id | unsupported_capability | baseline_conflict | unsupported_capability | 补测 |
| EC10 unsupported_currency_usd | unsupported_capability | currency | unsupported_capability | 补测 |

EC10 的六步共用空账本起点。宿主支持显式付款日，因此第一步产生新版本，随后四个关联字段请求仍引用 fixture-r0，在到达关联校验前已发生基线冲突。最后一步在金额／币种输入校验时返回 currency。桌面与 Android 的交换候选六次均拒绝，账本保持空。应保留原付款日期和未发送操作；直接去掉日期再发送会改变用户意图。

## 证据和未覆盖项

- 宿主使用临时 SQLite；Android 使用隔离 API 35 模拟器与固定 APK 的 WebView／Capacitor 原生方法。缺口检查保存每步原始返回、输入摘要和实际四项增量，复读已存消费字段、原意图、回执／待发送的操作键和结果版本；拒绝与重放逐项比较前后记录和历史。Android 分页取回全部当前消费。EC08 预置记录的内部 ID 和标题由各自测试库生成；起始笔数、金额、两笔新业务命令与绑定版本均按向量核对。
- EC02、EC03 的 Android 页面路径已有真实进程中断、持久待核实请求与冷启动恢复证据。宿主用子进程中断和重开验证账本、回执及同键重试，宿主调用方跨重启保留未提交输入未验证。缺口脚本的 setup_only=true 表示建立已提交起点，不能充当中断证据。
- EC07、EC10 的 preserve_input_for_retry 是候选要求。补测核对内存中的原请求字节摘要在调用前后相同，相同输入可由固定样例和绑定版本复建。未验证这两组每个拒绝／忙锁输入在调用方进程终止后仍能取回；宿主 EC10 首步另有已提交的完整回执意图。Android 的补测直接调用原生入口，没有模拟用户通过正式界面重新编辑这些字段。
- 以上均为隔离的单旅行／分支与虚构身份。尚未覆盖两台设备间交付与对端持久确认、生产身份、真机或个人库迁移。

## 复跑

在移动仓根目录，用 Bash 及含固定提交的桌面 Git 副本。固定 JSON 由命令显式导出，移动构建本身独立。设备命令需要维护文档中的 SDK、JDK、Gradle 环境、已启动的指定 API 35 模拟器和空闲 CDP 端口。可加 `--apk` 指向从移动基线构建的隔离调试 APK。

```bash
set -eo pipefail
d=$(mktemp -d)
ref=fb7ecc0c145486e761567ffc11fdce9198cae907
git -C ../TravelFlow-AI archive "$ref" desktop backend/tests/fixtures/p1_expense_create_vectors.json backend/tests/fixtures/p1_expense_create_candidate.json | tar -x -C "$d"
v="$d/backend/tests/fixtures/p1_expense_create_vectors.json"
(cd "$d" && python -m desktop.expense_vectors --json) > "$d/desktop.json"
node scripts/check-p1-vector-gaps.mjs "$v" > "$d/mobile-host.json"
node scripts/check-p1-bridge-android.mjs --serial emulator-5580 --cdp-port 19240 --desktop-vectors "$v" > "$d/android.json"
```

既有证据的独立入口为 `pnpm check:p1-desktop-create`、`pnpm check:p1-create-boundaries` 及上面 Android 命令移除 `--desktop-vectors "$v"` 后的 14 场景模式。本次复用其在 `0b43cff` 的验收结果。[原生运行环境及构建方法](MAINTAINING.md#p1-桥接消费更正与回执恢复复验)
