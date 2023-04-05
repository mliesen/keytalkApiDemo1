# KeyTalk logvalues

Logga keytalk värden och skriv till textfil.
Loggning sker med prenumeration, varje ändring skrivs ner  


Framtida - flytttal kan ges en floatRes vid prenumerationsstart


# Installation
i root mappen:

```
npm install typescript -g
npm install
```

Köra:

Ställ dig i mappen med config.jsonc. Kör
```
tsc
node ./dist/index.js
```


# Uppdatera schema
Kör
```
npm install ts-json-schema-generator -g
ts-json-schema-generator -p src/index.ts --type IConfigFile --no-type-check -o "config.schema.json"
```