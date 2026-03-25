-- Find the relationship between two people in the family tree.
-- Returns common ancestors with generation distances and traversal paths.
create or replace function public.find_relationship(
  person_a uuid,
  person_b uuid,
  max_depth int default 30
)
returns table (
  common_ancestor_id uuid,
  common_ancestor_name text,
  generations_from_a int,
  generations_from_b int,
  path_from_a uuid[],
  path_from_b uuid[]
)
language sql
stable
set search_path = public
as $$
  with recursive
  ancestors_a as (
    select a.id, a.name, 0 as generation, array[a.id] as path
    from ancestors a where a.id = person_a
    union all
    select a.id, a.name, aa.generation + 1, aa.path || a.id
    from ancestors a
    join ancestor_relationships ar on ar.parent_id = a.id
    join ancestors_a aa on ar.child_id = aa.id
    where aa.generation < max_depth
      and not a.id = any(aa.path)
  ),
  ancestors_b as (
    select a.id, a.name, 0 as generation, array[a.id] as path
    from ancestors a where a.id = person_b
    union all
    select a.id, a.name, ab.generation + 1, ab.path || a.id
    from ancestors a
    join ancestor_relationships ar on ar.parent_id = a.id
    join ancestors_b ab on ar.child_id = ab.id
    where ab.generation < max_depth
      and not a.id = any(ab.path)
  ),
  common as (
    select distinct on (aa.id)
      aa.id as common_ancestor_id,
      aa.name as common_ancestor_name,
      aa.generation as generations_from_a,
      ab.generation as generations_from_b,
      aa.path as path_from_a,
      ab.path as path_from_b
    from ancestors_a aa
    join ancestors_b ab on aa.id = ab.id
    order by aa.id, (aa.generation + ab.generation) asc
  )
  select * from common
  order by (generations_from_a + generations_from_b) asc
  limit 5;
$$;
