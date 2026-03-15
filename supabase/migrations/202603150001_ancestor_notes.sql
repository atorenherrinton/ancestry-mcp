create extension if not exists vector with schema extensions;

create table if not exists public.ancestor_notes (
  id uuid primary key default gen_random_uuid(),
  ancestor_id uuid references public.ancestors(id) on delete set null,
  content text not null,
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists ancestor_notes_embedding_hnsw_idx
  on public.ancestor_notes using hnsw (embedding extensions.vector_cosine_ops);

create index if not exists ancestor_notes_metadata_gin_idx
  on public.ancestor_notes using gin (metadata);

create index if not exists ancestor_notes_ancestor_id_idx
  on public.ancestor_notes (ancestor_id);

create index if not exists ancestor_notes_created_at_desc_idx
  on public.ancestor_notes (created_at desc);

create or replace function public.update_ancestor_notes_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists ancestor_notes_updated_at on public.ancestor_notes;
create trigger ancestor_notes_updated_at
  before update on public.ancestor_notes
  for each row
  execute function public.update_ancestor_notes_updated_at();

create or replace function public.match_ancestor_notes(
  query_embedding extensions.vector(1536),
  match_threshold float default 0.7,
  match_count int default 10,
  filter jsonb default '{}'::jsonb,
  p_ancestor_id uuid default null
)
returns table (
  id uuid,
  ancestor_id uuid,
  ancestor_name text,
  content text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
language plpgsql
stable
set search_path = public
as $$
begin
  return query
  select
    n.id,
    n.ancestor_id,
    a.name as ancestor_name,
    n.content,
    n.metadata,
    (1 - (n.embedding <=> query_embedding))::float as similarity,
    n.created_at
  from public.ancestor_notes n
  left join public.ancestors a on a.id = n.ancestor_id
  where 1 - (n.embedding <=> query_embedding) > match_threshold
    and (filter = '{}'::jsonb or n.metadata @> filter)
    and (p_ancestor_id is null or n.ancestor_id = p_ancestor_id)
  order by n.embedding <=> query_embedding
  limit match_count;
end;
$$;
