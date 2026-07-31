-- Run once in the COMMON Supabase project.
-- Individual Telegram destination copied from Elina's previous working website.
-- This statement changes only the row student_id = 'elina'.

insert into public.telegram_recipients (
  student_id,
  chat_id,
  enabled
)
values (
  'elina',
  -1003844097755,
  true
)
on conflict (student_id)
do update set
  chat_id = excluded.chat_id,
  enabled = true,
  updated_at = now();

select student_id, chat_id, enabled
from public.telegram_recipients
where student_id = 'elina';
