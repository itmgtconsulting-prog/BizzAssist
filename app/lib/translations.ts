export type Language = 'da' | 'en';

export const translations = {
  da: {
    nav: {
      features: 'Funktioner',
      useCases: 'Brug',
      pricing: 'Priser',
      about: 'Om os',
      login: 'Log ind',
      getStarted: 'Kom i gang gratis',
    },
    hero: {
      badge: 'Danmarks #1 forretningsintelligens platform',
      title: 'Data og Information om',
      titleHighlight: 'ejendomme, virksomheder og deres ejere',
      subtitle:
        'BizzAssist samler data fra offentlige data kilder og lader dig analysere det med AI.',
      searchPlaceholder: 'Søg på virksomhed, CVR-nummer, ejer eller adresse...',
      ctaPrimary: 'Start gratis',
      ctaSecondary: 'Se demo',
      trustedBy: 'Betroet af 500+ virksomheder i Danmark',
    },
    stats: [
      { value: '2M+', label: 'Virksomheder' },
      { value: '4M+', label: 'Ejendomme' },
      { value: '5M+', label: 'Personprofiler' },
      { value: '50+', label: 'Datakilder' },
    ],
    features: {
      title: 'Alt data. Ét sted.',
      subtitle:
        'Vi samler de vigtigste data om ejendomme, virksomheder og ejere fra alle relevante kilder i Danmark.',
      items: [
        {
          icon: 'building',
          title: 'Ejendomsdata',
          description:
            'Ejendomsvurderinger, ejerskifter, tinglysning, BBR-data, energimærker, salgshistorik og meget mere.',
        },
        {
          icon: 'briefcase',
          title: 'Virksomhedsdata',
          description:
            'CVR-oplysninger, årsregnskaber, bestyrelse, ejerskabsstruktur, kreditvurdering og brancheanalyse.',
        },
        {
          icon: 'users',
          title: 'Ejerdata',
          description:
            'Direktører, bestyrelsesmedlemmer, ejere, netværk og personlige forretningsforbindelser.',
        },
        {
          icon: 'sparkles',
          title: 'AI-analyse',
          description:
            'Stil spørgsmål om enhver virksomhed, ejendom eller ejer og få øjeblikkelige, datadrevne svar.',
        },
      ],
    },
    useCases: {
      title: 'Hvad kan du bruge BizzAssist til?',
      subtitle:
        'Fra konkurrentanalyse til due diligence — BizzAssist hjælper dig med at træffe bedre beslutninger.',
      items: [
        {
          title: 'Konkurrentanalyse',
          description:
            'Forstå dine konkurrenters økonomi, vækst, nøgletal og ejerskabsstruktur på få minutter.',
        },
        {
          title: 'Due Diligence',
          description:
            'Få et komplet billede af en virksomhed eller person inden du indgår aftaler eller partnerskaber.',
        },
        {
          title: 'Investeringsscreening',
          description:
            'Identificér attraktive investeringsmål baseret på finansielle nøgletal, vækst og ejendomsdata.',
        },
        {
          title: 'Leverandørvurdering',
          description:
            'Tjek dine leverandørers soliditet, ejerskab og finansielle sundhed inden du underskriver kontrakter.',
        },
        {
          title: 'Markedsanalyse',
          description:
            'Kortlæg et helt marked med data om aktører, vækstrater, geografi og konsolidering.',
        },
        {
          title: 'Ejendomsinvestering',
          description:
            'Analysér ejendomsmarkedet med data om priser, ejere, vurderinger og udviklingsmuligheder.',
        },
      ],
    },
    cta: {
      title: 'Klar til at prøve BizzAssist?',
      subtitle: 'Prøv BizzAssist gratis i 7 dage.',
      button: 'Start din gratis prøveperiode',
      secondary: 'Book en demo',
    },
    footer: {
      tagline: 'AI baseret forretningsintelligens platform.',
      product: 'Produkt',
      company: 'Virksomhed',
      legal: 'Juridisk',
      contact: 'Kontakt',
      links: {
        features: 'Funktioner',
        pricing: 'Priser',
        api: 'API',
        about: 'Om os',
        blog: 'Blog',
        careers: 'Karriere',
        privacy: 'Privatlivspolitik',
        terms: 'Vilkår og betingelser',
        cookies: 'Cookiepolitik',
        business: 'Forretning',
        support: 'Support',
      },
      supplier: {
        label: 'Leveret af',
        name: 'Pecunia IT ApS',
        cvr: 'CVR-nr: 44718502',
        address: 'Søbyvej 11, 2650 Hvidovre',
      },
      copyright: '© 2025 BizzAssist. Alle rettigheder forbeholdes.',
    },
    login: {
      title: 'Log ind på BizzAssist',
      subtitle: 'Adgang til Danmarks mest komplette forretningsintelligens',
      emailLabel: 'E-mail',
      emailPlaceholder: 'navn@virksomhed.dk',
      passwordLabel: 'Adgangskode',
      passwordPlaceholder: '••••••••',
      forgotPassword: 'Glemt adgangskode?',
      loginButton: 'Log ind',
      noAccount: 'Har du ikke en konto?',
      signUp: 'Opret konto',
      or: 'eller fortsæt med',
    },
  },
  en: {
    nav: {
      features: 'Features',
      useCases: 'Use Cases',
      pricing: 'Pricing',
      about: 'About',
      login: 'Log in',
      getStarted: 'Get started free',
    },
    hero: {
      badge: "Denmark's #1 business intelligence platform",
      title: 'Know everything about',
      titleHighlight: 'companies, properties & owners',
      subtitle:
        'BizzAssist aggregates data from hundreds of public and private sources and lets you analyse it with AI — in seconds.',
      searchPlaceholder: 'Search company, CVR number, owner or address...',
      ctaPrimary: 'Start for free',
      ctaSecondary: 'Watch demo',
      trustedBy: 'Trusted by 500+ companies in Denmark',
    },
    stats: [
      { value: '2M+', label: 'Companies' },
      { value: '4M+', label: 'Properties' },
      { value: '5M+', label: 'Owner profiles' },
      { value: '50+', label: 'Data sources' },
    ],
    features: {
      title: 'All data. One place.',
      subtitle:
        'We aggregate the most important data on properties, companies, and owners from all relevant sources in Denmark.',
      items: [
        {
          icon: 'building',
          title: 'Property Data',
          description:
            'Property valuations, ownership transfers, land registry, BBR data, energy labels, sales history and much more.',
        },
        {
          icon: 'briefcase',
          title: 'Company Data',
          description:
            'CVR information, annual reports, board, ownership structure, credit rating and industry analysis.',
        },
        {
          icon: 'users',
          title: 'Owner Data',
          description:
            'Directors, board members, owners, networks and personal business connections.',
        },
        {
          icon: 'sparkles',
          title: 'AI Analysis',
          description:
            'Ask questions about any company, property or owner and get instant, data-driven answers.',
        },
      ],
    },
    useCases: {
      title: 'What can you use BizzAssist for?',
      subtitle:
        'From competitor analysis to due diligence — BizzAssist helps you make better decisions.',
      items: [
        {
          title: 'Competitor Analysis',
          description:
            "Understand your competitors' finances, growth, metrics and ownership structure in minutes.",
        },
        {
          title: 'Due Diligence',
          description:
            'Get a complete picture of a company or person before entering into agreements or partnerships.',
        },
        {
          title: 'Investment Screening',
          description:
            'Identify attractive investment targets based on financial metrics, growth and property data.',
        },
        {
          title: 'Supplier Assessment',
          description:
            "Check your suppliers' financial health and ownership before signing contracts.",
        },
        {
          title: 'Market Analysis',
          description:
            'Map an entire market with data on players, growth rates, geography and consolidation.',
        },
        {
          title: 'Property Investment',
          description:
            'Analyse the property market with data on prices, owners, valuations and development opportunities.',
        },
      ],
    },
    cta: {
      title: 'Ready to try BizzAssist?',
      subtitle: 'Try BizzAssist free for 7 days.',
      button: 'Start your free trial',
      secondary: 'Book a demo',
    },
    footer: {
      tagline: 'AI-powered business intelligence platform.',
      product: 'Product',
      company: 'Company',
      legal: 'Legal',
      contact: 'Contact',
      links: {
        features: 'Features',
        pricing: 'Pricing',
        api: 'API',
        about: 'About us',
        blog: 'Blog',
        careers: 'Careers',
        privacy: 'Privacy Policy',
        terms: 'Terms & Conditions',
        cookies: 'Cookie Policy',
        business: 'Business',
        support: 'Support',
      },
      supplier: {
        label: 'Provided by',
        name: 'Pecunia IT ApS',
        cvr: 'CVR: 44718502',
        address: 'Søbyvej 11, 2650 Hvidovre',
      },
      copyright: '© 2025 BizzAssist. All rights reserved.',
    },
    login: {
      title: 'Log in to BizzAssist',
      subtitle: "Access Denmark's most comprehensive business intelligence",
      emailLabel: 'Email',
      emailPlaceholder: 'name@company.com',
      passwordLabel: 'Password',
      passwordPlaceholder: '••••••••',
      forgotPassword: 'Forgot password?',
      loginButton: 'Log in',
      noAccount: "Don't have an account?",
      signUp: 'Sign up',
      or: 'or continue with',
    },
  },
};
