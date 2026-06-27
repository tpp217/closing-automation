-- ============================================================================
-- closing-automation テナントデータ分離（マルチテナント化）
-- ----------------------------------------------------------------------------
-- 目的:
--   永続業務テーブル（business_reports / contractor_snapshots / dr_snapshots）に
--   tenant_id を導入し、クロステナント漏洩を防ぐ。
--
-- 防御の層:
--   1) アプリ層（主たる防御）= API（api/*.js）が service_role 接続のため、
--      全 read/write/delete を呼び出し元 tenant_id（wh JWT クレーム）でスコープする。
--   2) DB 層（多層防御）= RLS を有効化し、tenant_id = (auth.jwt() ->> 'tenant_id')
--      のポリシーを置く。service_role は RLS をバイパスするため現状は無害だが、
--      将来 authenticated 接続（PostgREST 直）に移行した場合の保険になる。
--
-- 既存データ:
--   現存データは全て utinc テナント（993aba82-bfa2-4fc8-ada9-928e2875120f）。
--   backfill で既存行に utinc を埋め、utinc ユーザーの挙動は不変（非破壊）。
--
-- 一意制約の調整:
--   business_reports は UNIQUE(store_name, period_ym) を持つ。別テナントが
--   同じ store_name+period_ym を持てるよう UNIQUE(tenant_id, store_name, period_ym)
--   へ張り替える。これに伴いアプリの upsert onConflict も
--   tenant_id,store_name,period_ym へ変更する（api/business-report.js）。
--   contractor_snapshots / dr_snapshots は元々一意制約が無く delete→insert 方式の
--   ため、一意制約の変更は不要（フィルタとポリシーのみ）。
--
-- 適用先: ops プロジェクト urzflutzgcioqswzmpkz（public スキーマ）
-- 適用は親が確認後に手動で行う（このリポジトリでは prod 未適用）。additive のみ。
-- ============================================================================

begin;

-- 既存データの所属テナント（utinc）
do $$
declare
  utinc_tenant constant text := '993aba82-bfa2-4fc8-ada9-928e2875120f';
begin

  -- ── business_reports ────────────────────────────────────────────────────
  alter table public.business_reports
    add column if not exists tenant_id text;

  update public.business_reports
    set tenant_id = utinc_tenant
    where tenant_id is null;

  -- 一意制約を tenant_id 込みへ張り替え（別テナントの同 store+period を許可）
  alter table public.business_reports
    drop constraint if exists business_reports_store_name_period_ym_key;
  alter table public.business_reports
    add constraint business_reports_tenant_store_period_key
    unique (tenant_id, store_name, period_ym);

  create index if not exists business_reports_tenant_idx
    on public.business_reports (tenant_id);

  -- ── contractor_snapshots ───────────────────────────────────────────────
  alter table public.contractor_snapshots
    add column if not exists tenant_id text;

  update public.contractor_snapshots
    set tenant_id = utinc_tenant
    where tenant_id is null;

  create index if not exists contractor_snapshots_tenant_idx
    on public.contractor_snapshots (tenant_id);

  create index if not exists contractor_snapshots_tenant_store_period_idx
    on public.contractor_snapshots (tenant_id, store_name, period_ym);

  -- ── dr_snapshots ───────────────────────────────────────────────────────
  alter table public.dr_snapshots
    add column if not exists tenant_id text;

  update public.dr_snapshots
    set tenant_id = utinc_tenant
    where tenant_id is null;

  create index if not exists dr_snapshots_tenant_idx
    on public.dr_snapshots (tenant_id);

  create index if not exists dr_snapshots_tenant_store_period_idx
    on public.dr_snapshots (tenant_id, store_name, period_ym);

end $$;

-- ── RLS（多層防御）─────────────────────────────────────────────────────────
-- service_role 接続（現行のアプリ）は RLS をバイパスするため挙動は不変。
-- authenticated（PostgREST 直）でアクセスした場合のみ tenant 一致が強制される。
alter table public.business_reports     enable row level security;
alter table public.contractor_snapshots enable row level security;
alter table public.dr_snapshots         enable row level security;

-- 冪等化のため既存ポリシーがあれば作り直す
drop policy if exists tenant_isolation on public.business_reports;
create policy tenant_isolation on public.business_reports
  for all
  to authenticated
  using      (tenant_id = (auth.jwt() ->> 'tenant_id'))
  with check (tenant_id = (auth.jwt() ->> 'tenant_id'));

drop policy if exists tenant_isolation on public.contractor_snapshots;
create policy tenant_isolation on public.contractor_snapshots
  for all
  to authenticated
  using      (tenant_id = (auth.jwt() ->> 'tenant_id'))
  with check (tenant_id = (auth.jwt() ->> 'tenant_id'));

drop policy if exists tenant_isolation on public.dr_snapshots
;
create policy tenant_isolation on public.dr_snapshots
  for all
  to authenticated
  using      (tenant_id = (auth.jwt() ->> 'tenant_id'))
  with check (tenant_id = (auth.jwt() ->> 'tenant_id'));

commit;
