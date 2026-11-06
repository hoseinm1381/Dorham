package com.dorham.chat
import java.net.URI
internal object NotificationPolicy {
    const val ALERT_GAP_MILLIS = 15000L
    fun mayAlert(previous: Long?, now: Long): Boolean = previous == null || previous < 0 || now < previous || now - previous >= ALERT_GAP_MILLIS
    fun shouldAlert(conversation: String, muted: Set<String>, previous: Map<String, Long>, now: Long): Boolean = conversation !in muted && mayAlert(previous[conversation], now)
    // Android's JSON bridge represents small whole numbers as Integer, not Long.
    // Accept exact JS-safe integers while retaining the stale-session guard.
    fun sessionGeneration(value: Any?): Long {
        require(value is Number)
        val number = value.toDouble()
        require(number.isFinite() && number >= 0 && number <= 9007199254740991.0 && number == number.toLong().toDouble())
        return number.toLong()
    }
    fun origin(value: String): String {
        val uri = URI(value)
        require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/"))
        require(uri.port == -1 || uri.port in 1..65535)
        return "https://${uri.rawAuthority}"
    }
    fun identifier(value: String) = value.matches(Regex("[a-zA-Z0-9_-]{1,80}"))
    fun retryMillis(failures: Int): Long = (1000L shl failures.coerceIn(0, 6)).coerceAtMost(60000L)
    fun remember(previous: List<String>, id: String): List<String> = (previous.filter { it != id } + id).takeLast(256)
}
