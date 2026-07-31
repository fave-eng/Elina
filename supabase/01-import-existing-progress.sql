-- Run once in the SQL Editor of the COMMON Supabase project.
-- Existing results confirmed by the old Elina table and the teacher screenshot.
-- The exact submission date of lesson 3 is not visible in the screenshot, so migration time is used.

insert into public.homework_progress (
  student_id,
  student_name,
  lesson_id,
  lesson_title,
  status,
  answers,
  score_correct,
  score_total,
  score_percent,
  checked_at,
  submitted_at,
  updated_at
)
values
(
  'elina', 'Elina', 'lesson-1', 'First Class', 'submitted',
  '{"migration_source":"old_elina_progress"}'::jsonb,
  5, 34, 15,
  '2026-07-09 14:40:38+00', '2026-07-09 14:40:38+00', now()
),
(
  'elina', 'Elina', 'lesson-2', 'Talking About Languages', 'submitted',
  '{"migration_source":"old_elina_progress"}'::jsonb,
  41, 49, 84,
  '2026-07-09 14:40:38+00', '2026-07-09 14:40:38+00', now()
),
(
  'elina', 'Elina', 'lesson-3', 'Feelings', 'submitted',
  '{"migration_source":"teacher_screenshot","exercise_6":"7/8"}'::jsonb,
  29, 33, 88,
  now(), now(), now()
)
on conflict (student_id, lesson_id)
do update set
  student_name = excluded.student_name,
  lesson_title = excluded.lesson_title,
  status = excluded.status,
  answers = case
    when public.homework_progress.answers is null
      or public.homework_progress.answers = '{}'::jsonb
    then excluded.answers
    else public.homework_progress.answers
  end,
  score_correct = excluded.score_correct,
  score_total = excluded.score_total,
  score_percent = excluded.score_percent,
  checked_at = coalesce(public.homework_progress.checked_at, excluded.checked_at),
  submitted_at = coalesce(public.homework_progress.submitted_at, excluded.submitted_at),
  updated_at = now();

select student_id, lesson_id, status, score_correct, score_total, score_percent, submitted_at
from public.homework_progress
where student_id = 'elina'
order by lesson_id;
