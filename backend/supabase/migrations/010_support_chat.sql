create table if not exists public.support_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  assigned_admin_id uuid references public.profiles(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'closed')),
  subject text,
  last_message text,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  support_conversation_id uuid not null references public.support_conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text not null,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_support_conversations_one_open
on public.support_conversations(user_id)
where status = 'open';

create index if not exists idx_support_conversations_status_updated
on public.support_conversations(status, updated_at desc);

create index if not exists idx_support_messages_conversation_created
on public.support_messages(support_conversation_id, created_at);

drop trigger if exists support_conversations_set_updated_at on public.support_conversations;
create trigger support_conversations_set_updated_at before update on public.support_conversations
for each row execute function public.set_updated_at();

alter table public.support_conversations enable row level security;
alter table public.support_messages enable row level security;

drop policy if exists "support participants read" on public.support_conversations;
create policy "support participants read" on public.support_conversations for select
using (
  auth.uid() = user_id
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
);

drop policy if exists "support participants insert" on public.support_conversations;
create policy "support participants insert" on public.support_conversations for insert
with check (auth.uid() = user_id);

drop policy if exists "support admin update" on public.support_conversations;
create policy "support admin update" on public.support_conversations for update
using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "support messages participants read" on public.support_messages;
create policy "support messages participants read" on public.support_messages for select
using (
  exists (
    select 1 from public.support_conversations sc
    where sc.id = support_conversation_id
      and (
        sc.user_id = auth.uid()
        or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
      )
  )
);

drop policy if exists "support messages participants insert" on public.support_messages;
create policy "support messages participants insert" on public.support_messages for insert
with check (
  sender_id = auth.uid()
  and exists (
    select 1 from public.support_conversations sc
    where sc.id = support_conversation_id
      and (
        sc.user_id = auth.uid()
        or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
      )
  )
);

notify pgrst, 'reload schema';
