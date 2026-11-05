// WMO weather interpretation codes (https://open-meteo.com/en/docs)
export function describeWeather(code) {
  if (code === 0) return { label: 'Clear', emoji: '☀️' };
  if (code === 1) return { label: 'Mainly clear', emoji: '🌤️' };
  if (code === 2) return { label: 'Partly cloudy', emoji: '⛅' };
  if (code === 3) return { label: 'Overcast', emoji: '☁️' };
  if (code === 45 || code === 48) return { label: 'Fog', emoji: '🌫️' };
  if (code >= 51 && code <= 57) return { label: 'Drizzle', emoji: '🌦️' };
  if (code >= 61 && code <= 67) return { label: 'Rain', emoji: '🌧️' };
  if (code >= 71 && code <= 77) return { label: 'Snow', emoji: '❄️' };
  if (code >= 80 && code <= 82) return { label: 'Showers', emoji: '🌧️' };
  if (code >= 85 && code <= 86) return { label: 'Snow showers', emoji: '🌨️' };
  if (code >= 95) return { label: 'Thunderstorm', emoji: '⛈️' };
  return { label: 'Unknown', emoji: '·' };
}
