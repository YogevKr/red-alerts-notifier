export const MESSAGE_TEMPLATES = {
  classifier: {
    preAlert: {
      upcomingAlertsRawTitle: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
    },
    stayNearbyUpdate: {
      rawTitles: [
        "ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו",
        "ניתן לצאת מהמרחב המוגן אך יש להשאר בקרבתו",
      ],
    },
    allClear: {
      rawTitles: [
        "האירוע הסתיים",
        "הארוע הסתיים",
        "סיום שהייה בסמיכות למרחב המוגן",
      ],
    },
    activeAlert: {
      rocketRawTitle: "ירי רקטות וטילים",
    },
    droneAlert: {
      rawTitle: "חדירת כלי טיס עוין",
    },
    earthquakeAlert: {
      rawTitle: "רעידת אדמה",
    },
  },
  whatsapp: {
    preAlert: {
      mediaBaseName: "general",
      upcomingAlertsTemplate:
        "בדקות הקרובות צפויות להתקבל התרעות באזורך עקב ירי טילים ורקטות.\n\nיש לשהות בסמוך למרחב מוגן ולהמשיך לעקוב אחר ההנחיות.",
      defaultTemplate: "התקבלה הנחיה מקדימה - יש לשהות בסמוך למרחב מוגן",
    },
    stayNearbyUpdate: {
      mediaBaseName: "general",
      template:
        "ניתן לצאת מהמרחב המוגן, אך יש להישאר בקרבתו ולהמשיך לעקוב אחר ההנחיות.",
    },
    allClear: {
      mediaBaseName: "general",
      template:
        "האירוע הסתיים - ניתן לצאת מהמרחב המוגן.\n\nאין צורך לשהות בסמוך למרחב מוגן.",
    },
    activeAlert: {
      mediaBaseName: "general",
      rocketTemplate:
        "ירי טילים ורקטות באזורך.\n\nיש להכנס למרחב המוגן ולשהות בו עד לקבלת הודעת שחרור.",
    },
    droneAlert: {
      mediaBaseName: "general",
      template:
        "עקב חדירת כלי טיס עוין הופעלה התרעה באזורך.\n\nיש להיכנס למרחב המוגן ולשהות בו עד קבלת הודעת שחרור.",
    },
    earthquakeAlert: {
      mediaBaseName: "general",
      template:
        "הופעלה התרעה בשל רעידת אדמה באזורך.\n\nצאו מיד לשטח פתוח.\n\nאם לא ניתן - הכנסו לממ\"ד והשאירו את הדלת והחלון פתוחים.",
    },
    generalAlert: {
      mediaBaseName: "general",
      useRawTitleAsTemplate: true,
      fallbackTemplate: "התקבלה התרעה - יש לפעול בהתאם להנחיות פיקוד העורף.",
    },
  },
};
