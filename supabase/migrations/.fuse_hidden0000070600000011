-- Seed the Galintel lintel range into a specific organisation's
-- supply items. One-shot — run once per org that wants the catalogue
-- pre-loaded.
--
-- Replace the org_name on line 13 if you want to seed a different
-- organisation. The script raises an exception (and the whole insert
-- rolls back) if the org doesn't exist, so a typo is safe.
--
-- Each item is configured as `per-opening` with rate 1 and a width
-- range. The Beme app picks the smallest range covering an opening's
-- width and adds one of those lintels to the tally.

do $$
declare
  v_org_id uuid;
  v_org_name text := 'ABC Building Products';
begin
  select id into v_org_id
  from public.organisations
  where name = v_org_name
  limit 1;

  if v_org_id is null then
    raise exception 'Organisation % not found', v_org_name;
  end if;

  insert into public.org_supply_items (
    organisation_id, name, description, unit, rate, applies_to,
    enabled_by_default, category, opening_width_min_mm, opening_width_max_mm
  ) values
    (v_org_id, 'Galintel 1200×100×100', '100mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 0,    1000),
    (v_org_id, 'Galintel 1500×100×100', '150mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 1001, 1200),
    (v_org_id, 'Galintel 1800×100×100', '150mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 1201, 1500),
    (v_org_id, 'Galintel 2100×100×100', '150mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 1501, 1800),
    (v_org_id, 'Galintel 2400×100×100', '150mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 1801, 2100),
    (v_org_id, 'Galintel 2700×100×100', '150mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 2101, 2400),
    (v_org_id, 'Galintel 3000×100×150', '150mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 2401, 2700),
    (v_org_id, 'Galintel 3300×100×150', '150mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 2701, 3000),
    (v_org_id, 'Galintel 3600×100×150', '150mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 3001, 3300),
    (v_org_id, 'Galintel 4000×100×150', '150mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 3301, 3700),
    (v_org_id, 'Galintel 4200×100×150', '150mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 3701, 3900),
    (v_org_id, 'Galintel 4500×100×150', '200mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 3901, 4100),
    (v_org_id, 'Galintel 5000×100×150', '200mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 4101, 4600),
    (v_org_id, 'Galintel 5200×100×150', '200mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 4601, 4800),
    (v_org_id, 'Galintel 5500×100×150', '200mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 4801, 5100),
    (v_org_id, 'Galintel 6000×100×150', '200mm bearing each side', 'per-opening', 1, array['block','brick'], true, 'Galintel', 5101, 5600);

  raise notice 'Seeded 16 Galintel items into organisation %', v_org_name;
end $$;
