/**
 * BIZZ-2105: Afvisningslogik for upload af standard forsikringsbetingelser.
 *
 * Standard betingelser deles på tværs af brugere i et domain, så dokumenter
 * med persondata ville være en GDPR-lækage, og individuelle policer/fakturaer
 * hører ikke hjemme i det delte bibliotek. Uploads valideres derfor af AI og
 * AFVISES (ingen DB-række, ingen Storage-fil) hvis dokumentet ikke er ægte
 * standard-betingelser eller indeholder persondata. Fail-closed: kan
 * valideringen ikke gennemføres, afvises uploaden også.
 *
 * @module app/lib/forsikring/standardDocValidation
 */

/** AI-vurdering af et uploadet dokument (delmængde af klassificerings-JSON) */
export interface StandardDocAiVurdering {
  /** true hvis dokumentet er generelle standard-betingelser */
  er_standard_betingelser?: boolean;
  /** true hvis dokumentet indeholder persondata (navne, CPR, kundenumre…) */
  indeholder_persondata?: boolean;
  /** AI'ens korte begrundelse for klassificeringen */
  begrundelse?: string;
}

/** Resultat af afvisningsvurderingen */
export interface AfvisningsResultat {
  /** true hvis uploaden skal afvises */
  afvist: boolean;
  /** Dansk fejlbesked til brugeren (null hvis accepteret) */
  aarsag: string | null;
}

/**
 * Afgør om et upload af standard-betingelser skal afvises.
 *
 * Regler (BIZZ-2105):
 * - vurdering === null (AI-kald fejlede eller AI-gate lukket) → AFVIS
 *   (fail-closed — gem aldrig uvaliderede delte dokumenter)
 * - indeholder_persondata === true → AFVIS (GDPR)
 * - er_standard_betingelser === false → AFVIS (individuel police/faktura mv.)
 * - ellers accepteret
 *
 * @param vurdering - AI-vurderingen, eller null hvis validering ikke kunne køres
 * @returns afvist-flag + dansk begrundelse til brugeren
 */
export function vurderStandardDocAfvisning(
  vurdering: StandardDocAiVurdering | null
): AfvisningsResultat {
  if (!vurdering) {
    return {
      afvist: true,
      aarsag:
        'Dokumentet kunne ikke valideres automatisk. Standard betingelser deles i dit domain og skal valideres før de gemmes — prøv igen om lidt.',
    };
  }
  if (vurdering.indeholder_persondata === true) {
    return {
      afvist: true,
      aarsag:
        'Dokumentet ser ud til at indeholde persondata (fx navne, CPR-numre, kundenumre eller individuelle policeoplysninger). Standard betingelser deles med andre brugere, så dokumenter med persondata kan ikke gemmes.' +
        (vurdering.begrundelse ? ` AI-vurdering: ${vurdering.begrundelse}` : ''),
    };
  }
  if (vurdering.er_standard_betingelser === false) {
    return {
      afvist: true,
      aarsag:
        'Dokumentet ser ikke ud til at være generelle standard-betingelser (fx en individuel police, faktura eller følgebrev). Kun selskabernes generelle vilkår kan gemmes i biblioteket.' +
        (vurdering.begrundelse ? ` AI-vurdering: ${vurdering.begrundelse}` : ''),
    };
  }
  return { afvist: false, aarsag: null };
}
