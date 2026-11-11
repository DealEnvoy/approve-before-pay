export type SampleRequest = {
  id: string;
  title: string;
  detail: string;
  text: string;
};

export const SAMPLES: SampleRequest[] = [
  {
    id: "plumber",
    title: "Boiler deposit",
    detail: "A straightforward trades request. The payee is new and no email is written down.",
    text: "Plumber needs a £150 deposit to book a boiler service next Tuesday",
  },
  {
    id: "rewire",
    title: "Two amounts",
    detail: "A callout figure and a deposit figure. The agent should pick the deposit and flag both.",
    text: "Electrician quoted £80 for a callout, but take a £800 deposit for the rewire before Friday.",
  },
  {
    id: "harbour",
    title: "Known payee",
    detail: "Harbour Plumbing is on the local list, with the matching email.",
    text: "Harbour Plumbing needs a £95 deposit to book a leak repair tomorrow. Email accounts@harbourplumbing.example.",
  },
  {
    id: "quickcash",
    title: "Large new payee",
    detail: "A euro amount at the large amount threshold, from a name that is not on the list.",
    text: "QuickCash Ltd wants €2,500 up front before they will start the kitchen on Monday. Send it to pay@quickcash.example.",
  },
];
