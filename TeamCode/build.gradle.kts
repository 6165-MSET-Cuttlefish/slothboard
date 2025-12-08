plugins {
	id("dev.frozenmilk.teamcode") version "10.3.0-0.1.4"
	id("dev.frozenmilk.sinister.sloth.load") version "0.2.2"
}

repositories {
	mavenLocal()
}

ftc {
	// use this to easily add more FTC libraries

	// adds support for kotlin
	kotlin
}

val slothboardVersion = findProperty("slothboard.version") as String? ?: "1.0.0"

dependencies {
	implementation("com.acmerobotics.slothboard:dashboard:$slothboardVersion")
}