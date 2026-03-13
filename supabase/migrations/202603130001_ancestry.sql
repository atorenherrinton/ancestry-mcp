create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create table if not exists public.ancestors (
  id uuid primary key default gen_random_uuid(),
  gedcom_xref text unique not null,
  name text not null,
  given_name text,
  surname text,
  sex char(1),
  birth_date text,
  birth_place text,
  death_date text,
  death_place text,
  burial_place text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.ancestor_relationships (
  parent_id uuid references public.ancestors(id) on delete cascade,
  child_id uuid references public.ancestors(id) on delete cascade,
  primary key (parent_id, child_id)
);

create index if not exists ancestors_name_trgm_idx
  on public.ancestors using gin (name extensions.gin_trgm_ops);

create index if not exists ancestors_surname_idx
  on public.ancestors (surname);

create index if not exists ancestors_gedcom_xref_idx
  on public.ancestors (gedcom_xref);

create or replace function public.trace_lineage(
  start_id uuid,
  max_generations int default 10
)
returns table (
  id uuid,
  name text,
  given_name text,
  surname text,
  sex char(1),
  birth_date text,
  birth_place text,
  death_date text,
  death_place text,
  generation int
)
language sql
stable
set search_path = public
as $$
  with recursive lineage as (
    select
      a.id,
      a.name,
      a.given_name,
      a.surname,
      a.sex,
      a.birth_date,
      a.birth_place,
      a.death_date,
      a.death_place,
      0 as generation
    from public.ancestors a
    where a.id = start_id

    union all

    select
      a.id,
      a.name,
      a.given_name,
      a.surname,
      a.sex,
      a.birth_date,
      a.birth_place,
      a.death_date,
      a.death_place,
      l.generation + 1
    from public.ancestors a
    join public.ancestor_relationships r on r.parent_id = a.id
    join lineage l on l.id = r.child_id
    where l.generation < max_generations
  )
  select * from lineage order by generation, name;
$$;

create or replace function public.search_ancestors(
  p_name text default null,
  p_given_name text default null,
  p_surname text default null,
  p_birth_date text default null,
  p_birth_year_from int default null,
  p_birth_year_to int default null,
  p_birth_place text default null,
  p_death_date text default null,
  p_death_year_from int default null,
  p_death_year_to int default null,
  p_death_place text default null,
  p_burial_place text default null,
  p_sex text default null,
  p_limit int default 20
)
returns table (
  id uuid,
  gedcom_xref text,
  name text,
  given_name text,
  surname text,
  sex char(1),
  birth_date text,
  birth_place text,
  death_date text,
  death_place text,
  burial_place text,
  created_at timestamptz
)
language sql
stable
set search_path = public
as $$
  select
    a.id,
    a.gedcom_xref,
    a.name,
    a.given_name,
    a.surname,
    a.sex,
    a.birth_date,
    a.birth_place,
    a.death_date,
    a.death_place,
    a.burial_place,
    a.created_at
  from public.ancestors a
  where (p_name is null or a.name ilike '%' || p_name || '%')
    and (p_given_name is null or a.given_name ilike '%' || p_given_name || '%')
    and (p_surname is null or a.surname ilike '%' || p_surname || '%')
    and (p_birth_date is null or a.birth_date ilike '%' || p_birth_date || '%')
    and (
      p_birth_year_from is null
      or nullif(substring(coalesce(a.birth_date, '') from '([0-9]{4})'), '')::int >= p_birth_year_from
    )
    and (
      p_birth_year_to is null
      or nullif(substring(coalesce(a.birth_date, '') from '([0-9]{4})'), '')::int <= p_birth_year_to
    )
    and (p_birth_place is null or a.birth_place ilike '%' || p_birth_place || '%')
    and (p_death_date is null or a.death_date ilike '%' || p_death_date || '%')
    and (
      p_death_year_from is null
      or nullif(substring(coalesce(a.death_date, '') from '([0-9]{4})'), '')::int >= p_death_year_from
    )
    and (
      p_death_year_to is null
      or nullif(substring(coalesce(a.death_date, '') from '([0-9]{4})'), '')::int <= p_death_year_to
    )
    and (p_death_place is null or a.death_place ilike '%' || p_death_place || '%')
    and (p_burial_place is null or a.burial_place ilike '%' || p_burial_place || '%')
    and (p_sex is null or a.sex = upper(left(p_sex, 1)))
  order by a.surname nulls last, a.given_name nulls last, a.name
  limit greatest(coalesce(p_limit, 20), 1);
$$;