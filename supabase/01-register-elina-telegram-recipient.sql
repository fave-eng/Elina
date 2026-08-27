-- Run once in the COMMON Supabase project.
-- Telegram destination for Elina: group https://t.me/c/3844097755 with topic/message_thread_id 13.
-- This changes only the row student_id = 'elina'.

alter table public.telegram_recipients
  add column if not exists message_thread_id bigint;

insert into public.telegram_recipients (
  student_id,
  chat_id,
  message_thread_id,
  enabled
)
values (
  'elina',
  -1003844097755,
  13,
  true
)
on conflict (student_id)
do update set
  chat_id = excluded.chat_id,
  message_thread_id = excluded.message_thread_id,
  enabled = true,
  updated_at = now();

select student_id, chat_id, message_thread_id, enabled
from public.telegram_recipients
where student_id = 'elina';
