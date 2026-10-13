// Content for the practice hand and demo mode. The four prototype hands are already public.
const WP = t => "https://en.wikipedia.org/wiki/" + t;

export const DAYS = [
 [
  {fam:"Film & TV", a:"Bond villain", b:"their film", pairs:[["Le Chiffre","Casino Royale"],["Raoul Silva","Skyfall"],["Alec Trevelyan","GoldenEye"],["Max Zorin","A View to a Kill"],["Elliot Carver","Tomorrow Never Dies"],["Karl Stromberg","The Spy Who Loved Me"]],
   fact:"Max Zorin was played by Christopher Walken, opposite Roger Moore in his final outing as Bond.", src:WP("A_View_to_a_Kill")},
  {fam:"Geography", a:"River", b:"country", pairs:[["Loire","France"],["Shannon","Ireland"],["Po","Italy"],["Murray","Australia"],["Vistula","Poland"],["Shinano","Japan"]],
   fact:"The Shinano is Japan's longest river, at about 367 km.", src:WP("Shinano_River")},
  {fam:"Science & Nature", a:"Element", b:"symbol", pairs:[["Gold","Au"],["Iron","Fe"],["Sodium","Na"],["Lead","Pb"],["Tungsten","W"],["Antimony","Sb"]],
   fact:"Tungsten's symbol, W, comes from its other name: wolfram.", src:WP("Tungsten")},
  {fam:"Music", a:"90s British album", b:"artist", pairs:[["OK Computer","Radiohead"],["Different Class","Pulp"],["Blue Lines","Massive Attack"],["Parklife","Blur"],["(What's the Story) Morning Glory?","Oasis"],["Dummy","Portishead"]],
   fact:"Blue Lines (1991), by Bristol's Massive Attack, is often credited with launching trip-hop.", src:WP("Blue_Lines")},
  {fam:"Food & Drink", a:"Pasta shape", b:"what the name means", pairs:[["Farfalle","butterflies"],["Conchiglie","shells"],["Penne","quills"],["Linguine","little tongues"],["Orecchiette","little ears"],["Vermicelli","little worms"]],
   fact:"Orecchiette come from Puglia, the heel of Italy's boot.", src:WP("Orecchiette")}
 ],
 [
  {fam:"Film & TV", a:"Sitcom", b:"where it's set", pairs:[["Frasier","Seattle"],["Cheers","Boston"],["Fawlty Towers","Torquay"],["Only Fools and Horses","Peckham"],["The Office (UK)","Slough"],["Peep Show","Croydon"]],
   fact:"Basil Fawlty was based on a real Torquay hotelier the Monty Python team met while staying at his hotel in 1970.", src:WP("Fawlty_Towers")},
  {fam:"History", a:"Battle", b:"war", pairs:[["Waterloo","Napoleonic Wars"],["Gettysburg","American Civil War"],["Stalingrad","Second World War"],["The Somme","First World War"],["Bosworth","Wars of the Roses"],["Agincourt","Hundred Years' War"]],
   fact:"The Hundred Years' War lasted 116 years, from 1337 to 1453.", src:WP("Hundred_Years%27_War")},
  {fam:"Science & Nature", a:"Animal", b:"collective noun", pairs:[["Lions","pride"],["Crows","murder"],["Owls","parliament"],["Flamingos","flamboyance"],["Rhinos","crash"],["Jellyfish","smack"]],
   fact:"Many collective nouns for animals were first recorded in the Book of St Albans, printed in 1486.", src:WP("Book_of_St_Albans")},
  {fam:"Sport", a:"Football stadium", b:"club", pairs:[["Anfield","Liverpool"],["Camp Nou","Barcelona"],["Santiago Bernabéu","Real Madrid"],["Signal Iduna Park","Borussia Dortmund"],["Estádio da Luz","Benfica"],["La Bombonera","Boca Juniors"]],
   fact:"La Bombonera means 'the chocolate box' in Spanish, after the stadium's tall, boxy shape.", src:WP("La_Bombonera")},
  {fam:"Language", a:"English word", b:"language it came from", pairs:[["Kindergarten","German"],["Robot","Czech"],["Algebra","Arabic"],["Kayak","Inuit"],["Shampoo","Hindi"],["Ombudsman","Swedish"]],
   fact:"'Robot' comes from the Czech robota, meaning forced labour. It first appeared in Karel Čapek's 1920 play R.U.R.", src:WP("R.U.R.")}
 ],
 [
  {fam:"Film & TV", a:"Thriller or horror film", b:"director", pairs:[["Jaws","Steven Spielberg"],["Psycho (1960)","Alfred Hitchcock"],["The Shining","Stanley Kubrick"],["Parasite","Bong Joon-ho"],["Se7en","David Fincher"],["Get Out","Jordan Peele"]],
   fact:"The mechanical shark in Jaws was nicknamed Bruce, after Spielberg's lawyer.", src:WP("Jaws_(film)")},
  {fam:"Sport", a:"Sport", b:"players per side", pairs:[["Basketball","5"],["Volleyball","6"],["Netball","7"],["Baseball","9"],["Rugby league","13"],["Rugby union","15"]],
   fact:"Basketball was invented in 1891 by James Naismith, a Canadian teacher working in Massachusetts.", src:WP("James_Naismith")},
  {fam:"Geography", a:"20th-century landmark", b:"city", pairs:[["Christ the Redeemer","Rio de Janeiro"],["Petronas Towers","Kuala Lumpur"],["Space Needle","Seattle"],["Atomium","Brussels"],["Burj Al Arab","Dubai"],["CN Tower","Toronto"]],
   fact:"The Atomium was built for the 1958 World's Fair in Brussels.", src:WP("Atomium")},
  {fam:"Art & Literature", a:"19th-century painting", b:"artist", pairs:[["The Hay Wain","John Constable"],["The Starry Night","Vincent van Gogh"],["The Scream","Edvard Munch"],["The Fighting Temeraire","J. M. W. Turner"],["Impression, Sunrise","Claude Monet"],["Liberty Leading the People","Eugène Delacroix"]],
   fact:"The cottage on the left of The Hay Wain (1821) still stands, almost unchanged, at Flatford in Suffolk.", src:WP("The_Hay_Wain")},
  {fam:"Science & Nature", a:"Moon", b:"the world it orbits", pairs:[["Titan","Saturn"],["Europa","Jupiter"],["Phobos","Mars"],["Charon","Pluto"],["Triton","Neptune"],["Miranda","Uranus"]],
   fact:"Titan is the only moon in the solar system with a thick atmosphere.", src:WP("Titan_(moon)")}
 ],
 [
  {fam:"Film & TV", a:"TV drama character", b:"show", pairs:[["Walter White","Breaking Bad"],["Jon Snow","Game of Thrones"],["Tony Soprano","The Sopranos"],["Don Draper","Mad Men"],["Omar Little","The Wire"],["Carrie Mathison","Homeland"]],
   fact:"Bryan Cranston won four Emmys for playing Walter White in Breaking Bad.", src:WP("Bryan_Cranston")},
  {fam:"History", a:"Monarch", b:"royal house", pairs:[["Henry VIII","Tudor"],["Elizabeth II","Windsor"],["Victoria","Hanover"],["Charles I","Stuart"],["Richard III","York"],["Edward VII","Saxe-Coburg and Gotha"]],
   fact:"The royal house was called Saxe-Coburg and Gotha until 1917, when George V renamed it Windsor during the First World War.", src:WP("House_of_Windsor")},
  {fam:"Music", a:"Musical", b:"composer", pairs:[["Cats","Andrew Lloyd Webber"],["Hamilton","Lin-Manuel Miranda"],["West Side Story","Leonard Bernstein"],["Les Misérables","Claude-Michel Schönberg"],["Wicked","Stephen Schwartz"],["Matilda","Tim Minchin"]],
   fact:"Les Misérables began as a French show in Paris in 1980, five years before the London production opened.", src:WP("Les_Mis%C3%A9rables_(musical)")},
  {fam:"Food & Drink", a:"Cocktail", b:"base spirit", pairs:[["Mojito","rum"],["Margarita","tequila"],["Negroni","gin"],["Moscow Mule","vodka"],["Old Fashioned","whiskey"],["Sidecar","brandy"]],
   fact:"The Negroni is said to be named after Count Camillo Negroni, who asked for gin instead of soda water in his Americano.", src:WP("Negroni")},
  {fam:"Geography", a:"Country", b:"currency", pairs:[["Japan","yen"],["India","rupee"],["Switzerland","franc"],["Brazil","real"],["South Africa","rand"],["Poland","złoty"]],
   fact:"Złoty means 'golden' in Polish.", src:WP("Polish_z%C5%82oty")}
 ]
];

/* Practice hand: fixed, easy categories nearly everyone knows */
export const TUTORIAL = [
  {fam:"Geography", a:"Country", b:"capital", pairs:[["France","Paris"],["Italy","Rome"],["Spain","Madrid"],["Japan","Tokyo"],["Egypt","Cairo"],["Germany","Berlin"]],
   fact:"Rome surrounds Vatican City, the world's smallest country.", src:WP("Vatican_City")},
  {fam:"Science & Nature", a:"Animal", b:"its baby", pairs:[["Cat","kitten"],["Dog","puppy"],["Cow","calf"],["Sheep","lamb"],["Horse","foal"],["Frog","tadpole"]],
   fact:"A baby kangaroo is called a joey. It's about the size of a jelly bean when it's born.", src:WP("Kangaroo")},
  {fam:"Film & TV", a:"Superhero", b:"secret identity", pairs:[["Batman","Bruce Wayne"],["Superman","Clark Kent"],["Spider-Man","Peter Parker"],["Iron Man","Tony Stark"],["Wonder Woman","Diana Prince"],["The Hulk","Bruce Banner"]],
   fact:"Superman first appeared in Action Comics #1, in 1938.", src:WP("Action_Comics_1")},
  {fam:"Food & Drink", a:"Dish", b:"main ingredient", pairs:[["Guacamole","avocado"],["Hummus","chickpeas"],["Omelette","eggs"],["Chips","potatoes"],["Popcorn","corn"],["Fondue","cheese"]],
   fact:"Hummus is simply the Arabic word for chickpeas.", src:WP("Hummus")},
  {fam:"Sport", a:"Sport", b:"where it's played", pairs:[["Tennis","court"],["Golf","course"],["Boxing","ring"],["Swimming","pool"],["Football","pitch"],["Ice hockey","rink"]],
   fact:"An Olympic swimming pool is 50 metres long.", src:WP("Olympic-size_swimming_pool")}
];


export const FAMILY_EMOJI = {"Film & TV":"🎬","Music":"🎵","Sport":"⚽","Geography":"🌍","History":"📜","Science & Nature":"🔬","Food & Drink":"🍽️","Language":"🔤","Art & Literature":"🎨","Pop Culture":"✨"};

/** Converts the prototype format into what the engine and server use. */
export function toHand(cats, number) {
  return {
    number,
    categories: cats.map((c, slot) => ({ slot, label: c.a + " → " + c.b, family: c.fam, categoryId: "DEMO-" + number + "-" + slot })),
    rounds: cats.map(c => ({ prompts: c.pairs.map(p => p[0]), answers: c.pairs.map(p => p[1]), fact: c.fact, src: c.src })),
  };
}
