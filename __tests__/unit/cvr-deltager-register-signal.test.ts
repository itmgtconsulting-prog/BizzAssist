/**
 * BIZZ-2234: CVR-ejerregister-signal i deltager-delta-ingestion.
 *
 * Regressionstest for at pull-cvr-deltager-aendringer nu udleder type='register'
 * relationer med ejerandel_pct fra REGISTER-hovedtype-organisationer. Fixturet er
 * bygget efter en RIGTIG CVR ES deltager-payload (probet 2026-09-05): EJERANDEL_PROCENT
 * ligger i org.medlemsData[].attributter, mens FUNKTION='EJERREGISTER' ligger paa
 * org.attributter (org-niveau). Uden fixet tabtes signalet -> M&A-radaren stod tom.
 */
import { describe, it, expect } from 'vitest';
import { mapDeltagerHit, normalizeRolle } from '@/app/api/cron/pull-cvr-deltager-aendringer/route';

/** Byg et deltager-hit med én REGISTER-org (spejler ægte CVR ES-struktur). */
function registerHit(opts: {
  ejerandel: string;
  gyldigFra?: string;
  gyldigTil?: string | null;
  extraFunktion?: string; // fx en LEDELSESORGAN-rolle på samme cvr
}) {
  const ejerPeriode = {
    gyldigFra: opts.gyldigFra ?? '2024-08-26',
    gyldigTil: opts.gyldigTil ?? null,
  };
  const organisationer: Record<string, unknown>[] = [
    {
      hovedtype: 'REGISTER',
      // FUNKTION='EJERREGISTER' ligger på ORG-niveau, ikke i medlemsData:
      attributter: [
        {
          type: 'FUNKTION',
          vaerdier: [
            { vaerdi: 'EJERREGISTER', periode: { gyldigFra: '2024-08-26', gyldigTil: null } },
          ],
        },
      ],
      medlemsData: [
        {
          attributter: [
            {
              type: 'EJERANDEL_PROCENT',
              vaerdier: [
                {
                  vaerdi: opts.ejerandel,
                  periode: ejerPeriode,
                  sidstOpdateret: '2024-08-26T00:00:00.000+02:00',
                },
              ],
            },
          ],
        },
      ],
    },
  ];
  if (opts.extraFunktion) {
    organisationer.push({
      hovedtype: 'LEDELSESORGAN',
      medlemsData: [
        {
          attributter: [
            {
              type: 'FUNKTION',
              vaerdier: [
                {
                  vaerdi: opts.extraFunktion,
                  periode: { gyldigFra: '2020-01-01', gyldigTil: null },
                },
              ],
            },
          ],
        },
      ],
    });
  }
  return {
    _source: {
      Vrdeltagerperson: {
        enhedsNummer: 4010037934,
        navne: [{ navn: 'Jesper Thorslund', periode: { gyldigTil: null } }],
        virksomhedSummariskRelation: [{ virksomhed: { cvrNummer: 44996790 }, organisationer }],
        sidstOpdateret: '2024-08-26T00:00:00.000+02:00',
      },
    },
  };
}

describe('BIZZ-2234 CVR register-signal', () => {
  it('normalizeRolle beholder register-relateret fald-igennem', () => {
    // 'EJERREGISTER' er en FUNKTION-værdi; registerrækken dannes af hovedtype-grenen,
    // ikke normalizeRolle — men normalizeRolle må ikke crashe på den.
    expect(normalizeRolle('EJERREGISTER')).toBe('ejerregister');
    expect(normalizeRolle('Adm. direktør')).toBe('direktør');
  });

  it('udleder type=register med ejerandel_pct fra REGISTER-org (fraktion → pct)', () => {
    const res = mapDeltagerHit(registerHit({ ejerandel: '1.0' }));
    expect(res).not.toBeNull();
    const reg = res!.relationer.filter((r) => r.type === 'register');
    expect(reg).toHaveLength(1);
    expect(reg[0].ejerandel_pct).toBe(100); // 1.0 (fraktion) → 100 %
    expect(reg[0].virksomhed_cvr).toBe('44996790');
    expect(reg[0].gyldig_fra).toBe('2024-08-26');
    expect(reg[0].gyldig_til).toBeNull();
    expect(reg[0].sidst_opdateret).toBe('2024-08-26T00:00:00.000+02:00');
  });

  it('skalerer minoritetsandel korrekt (0.05 → 5 %)', () => {
    const res = mapDeltagerHit(registerHit({ ejerandel: '0.05' }));
    const reg = res!.relationer.find((r) => r.type === 'register');
    expect(reg?.ejerandel_pct).toBe(5);
  });

  it('sætter gyldig_til på lukket ejerandel-periode (exit-signal)', () => {
    const res = mapDeltagerHit(registerHit({ ejerandel: '0.10', gyldigTil: '2025-03-01' }));
    const reg = res!.relationer.find((r) => r.type === 'register');
    expect(reg?.gyldig_til).toBe('2025-03-01');
    expect(reg?.ejerandel_pct).toBe(10);
  });

  it('register-rækken matcher mv_virksomhedshandel_kandidater-filteret (register + ejerandel_pct not null)', () => {
    const res = mapDeltagerHit(registerHit({ ejerandel: '0.25', extraFunktion: 'Adm. direktør' }));
    // Registerrækken skal findes selv når deltageren OGSÅ har en ledelsesrolle.
    const matcher = res!.relationer.filter(
      (r) => ['register', 'reel_ejer', 'interessenter'].includes(r.type) && r.ejerandel_pct !== null
    );
    expect(matcher).toHaveLength(1);
    expect(matcher[0].type).toBe('register');
    expect(matcher[0].ejerandel_pct).toBe(25);
    // Ledelsesrollen bevares uændret (uden ejerandel).
    expect(res!.relationer.some((r) => r.type === 'direktør' && r.ejerandel_pct === null)).toBe(
      true
    );
  });
});
