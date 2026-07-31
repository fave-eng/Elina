-- Elina: безопасная RLS-настройка для public.homework_progress
--
-- Браузер может:
--   1) читать строки Элины;
--   2) создавать и обновлять только draft/checked;
-- Браузер НЕ может самостоятельно выставлять submitted или менять финальные строки.
-- Финализацию выполняет Supabase Edge Function через service_role.

alter table public.homework_progress enable row level security;

grant select, insert, update on table public.homework_progress to anon;
revoke delete on table public.homework_progress from anon;

drop policy if exists elina_public_read_homework on public.homework_progress;
create policy elina_public_read_homework
on public.homework_progress
for select
to anon
using (student_id = 'elina');

drop policy if exists elina_public_insert_homework_draft on public.homework_progress;
create policy elina_public_insert_homework_draft
on public.homework_progress
for insert
to anon
with check (
  student_id = 'elina'
  and status in ('draft', 'checked')
  and submitted_at is null
  and locked_at is null
  and coalesce(report_status, 'not_sent') = 'not_sent'
  and report_sent_at is null
);

drop policy if exists elina_public_update_homework_draft on public.homework_progress;
create policy elina_public_update_homework_draft
on public.homework_progress
for update
to anon
using (
  student_id = 'elina'
  and status in ('draft', 'checked')
)
with check (
  student_id = 'elina'
  and status in ('draft', 'checked')
  and submitted_at is null
  and locked_at is null
  and coalesce(report_status, 'not_sent') = 'not_sent'
  and report_sent_at is null
);

notify pgrst, 'reload schema';

-- Проверка созданных политик.
select
  policyname,
  cmd,
  roles,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'homework_progress'
order by policyname;

-- Проверка, что три результата остались на месте.
select
  student_id,
  lesson_id,
  status,
  score_correct,
  score_total,
  score_percent,
  submitted_at,
  locked_at
from public.homework_progress
where student_id = 'elina'
order by lesson_id;
